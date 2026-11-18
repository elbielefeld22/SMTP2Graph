import fs from 'fs';
import http from 'http';
import https from 'https';
import { randomBytes } from 'crypto';
import axios from 'axios';
import { CryptoProvider } from '@azure/msal-node';
import { simpleParser } from 'mailparser';
import { Config } from './Config';
import { Archive, MailStatus } from './Archive';
import { MailQueue } from './MailQueue';
import { Mailer } from './Mailer';
import { Notifier } from './Notifier';
import { readHeaders, decodeHeader } from './MailHeaders';
import { TeamsApp } from './TeamsApp';
import { prefixedLog } from './Logger';
import indexHtml from '../web/index.html';
import teamsHtml from '../web/teams.html';

const log = prefixedLog('WebServer');

interface IUser
{
    name: string;
    upn: string;
    oid?: string;
}

interface ISession
{
    user: IUser;
    expires: number;
}

interface IPendingLogin
{
    verifier: string;
    returnTo: string;
    expires: number;
}

const SESSION_COOKIE = 'smtp2graph_session';
const CSRF_HEADER = 'x-smtp2graph';

class HttpError extends Error
{
    constructor(public status: number, message: string)
    {
        super(message);
    }
}

export class WebServer
{
    #server: http.Server|https.Server;
    #queue: MailQueue;
    #sessions = new Map<string, ISession>();
    #pendingLogins = new Map<string, IPendingLogin>();
    #crypto = new CryptoProvider();

    constructor(queue: MailQueue)
    {
        this.#queue = queue;
        const handler = (req: http.IncomingMessage, res: http.ServerResponse)=>{
            this.#handle(req, res).catch(error=>{
                const status = error instanceof HttpError?error.status:500;
                if(status === 500) log('error', `Request "${req.method} ${req.url}" failed`, {error});
                if(!res.headersSent) this.#json(res, status, {error: error instanceof HttpError?error.message:'Internal server error'});
                else res.end();
            });
        };

        if(Config.webTlsKeyPath && Config.webTlsCertPath)
            this.#server = https.createServer({key: fs.readFileSync(Config.webTlsKeyPath), cert: fs.readFileSync(Config.webTlsCertPath)}, handler);
        else
            this.#server = http.createServer(handler);

        // Purge expired sessions/logins every 10 minutes
        setInterval(()=>{
            const now = Date.now();
            for(const [k,v] of this.#sessions) if(v.expires < now) this.#sessions.delete(k);
            for(const [k,v] of this.#pendingLogins) if(v.expires < now) this.#pendingLogins.delete(k);
        }, 10*60*1000).unref();
    }

    listen()
    {
        if(!Config.webAuthEnabled)
            log('warn', 'The web interface login is DISABLED. Everybody who can reach the web port can read all mails!');

        return new Promise<void>((resolve, reject)=>{
            this.#server.once('error', reject);
            this.#server.listen(Config.webPort, Config.webListenIp, ()=>{
                this.#server.off('error', reject);
                this.#server.on('error', error=>log('error', 'An error occured', {error}));
                log('info', `Web interface started on ${Config.webListenIp || 'any-ip'}:${Config.webPort}${Config.webPublicUrl?` (${Config.webPublicUrl})`:''}`);
                resolve();
            });
        });
    }

    get #redirectUri()
    {
        return `${Config.webPublicUrl}/auth/callback`;
    }

    get #secureCookies()
    {
        return Boolean(Config.webPublicUrl?.startsWith('https://'));
    }

    async #handle(req: http.IncomingMessage, res: http.ServerResponse)
    {
        const url = new URL(req.url || '/', 'http://localhost');
        const p = url.pathname;
        const method = req.method || 'GET';

        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('Cache-Control', 'no-store');

        // --- Public routes ---
        if(method === 'GET' && p === '/teams') // Landing page for the Teams personal tab, contains no data
            return this.#html(res, teamsHtml.replace(/__PUBLIC_URL__/g, this.#escape(Config.webPublicUrl || '/')), true);
        if(method === 'GET' && p === '/auth/login') return this.#login(res, url);
        if(method === 'GET' && p === '/auth/callback') return this.#callback(res, url);
        if(method === 'GET' && p === '/auth/logout') return this.#logout(req, res);
        if(method === 'GET' && p === '/favicon.ico') { res.statusCode = 204; return res.end(); }

        // --- Authentication ---
        const user = this.#getUser(req);
        if(!user)
        {
            if(p.startsWith('/api/')) throw new HttpError(401, 'Not logged in');
            res.statusCode = 302;
            res.setHeader('Location', `/auth/login?returnTo=${encodeURIComponent(url.pathname + url.search)}`);
            return res.end();
        }

        // CSRF protection: state changing requests need our custom header (not settable cross-origin without CORS)
        if(method !== 'GET' && req.headers[CSRF_HEADER] !== '1')
            throw new HttpError(403, 'Missing CSRF header');

        // --- Protected routes ---
        if(method === 'GET' && (p === '/' || p === '/index.html'))
            return this.#html(res, indexHtml.replace(/__VERSION__/g, this.#escape(VERSION)));

        if(method === 'GET' && p === '/api/me')
            return this.#json(res, 200, {user, authEnabled: Config.webAuthEnabled, version: VERSION, mode: Config.mode,
                retentionDays: Config.archiveRetentionDays, storeContent: Config.archiveStoreContent,
                notify: {enabled: Notifier.enabled, recipients: Config.notifyTeams?.recipients ?? [], teamsAppProblems: TeamsApp.problems()}});

        if(method === 'GET' && p === '/api/mails')
        {
            const status = url.searchParams.get('status') || undefined;
            if(status && !['queued','retrying','sent','failed'].includes(status)) throw new HttpError(400, 'Invalid status');
            return this.#json(res, 200, Archive.search({
                q: url.searchParams.get('q')?.trim() || undefined,
                status: status as MailStatus|undefined,
                from: this.#num(url.searchParams.get('from')),
                to: this.#num(url.searchParams.get('to')),
                limit: this.#num(url.searchParams.get('limit')),
                offset: this.#num(url.searchParams.get('offset')),
            }));
        }

        if(method === 'GET' && p === '/api/stats')
        {
            const days = Math.min(Math.max(this.#num(url.searchParams.get('days')) ?? 30, 1), 365);
            return this.#json(res, 200, Archive.stats(days) ?? {});
        }

        const mailMatch = /^\/api\/mails\/([^/]+)(\/eml|\/resend)?$/.exec(p);
        if(mailMatch)
        {
            const id = decodeURIComponent(mailMatch[1]);
            const record = Archive.get(id);
            if(!record) throw new HttpError(404, 'Mail not found');

            if(method === 'GET' && !mailMatch[2]) return this.#json(res, 200, await this.#details(id));

            if(method === 'GET' && mailMatch[2] === '/eml')
            {
                const file = Archive.filePath(record);
                if(!file) throw new HttpError(404, 'The mail file is no longer available');
                res.setHeader('Content-Type', 'message/rfc822');
                res.setHeader('Content-Disposition', `attachment; filename="${record.id.replace(/[^\w.\-]/g, '_')}"`);
                log('info', `User "${user.upn}" downloaded mail "${id}"`);
                return fs.createReadStream(file).pipe(res);
            }

            if(method === 'POST' && mailMatch[2] === '/resend')
            {
                const error = this.#queue.resend(id, user.upn);
                if(error) throw new HttpError(409, error);
                return this.#json(res, 200, {ok: true});
            }
        }

        if(method === 'GET' && p === '/api/teams-app.zip')
        {
            const problems = TeamsApp.problems();
            if(problems.length) throw new HttpError(400, `Cannot build the Teams app: ${problems.join(', ')}`);
            res.setHeader('Content-Type', 'application/zip');
            res.setHeader('Content-Disposition', 'attachment; filename="smtp2graph-teams-app.zip"');
            return res.end(TeamsApp.package());
        }

        if(method === 'POST' && p === '/api/notify/test')
        {
            if(!Notifier.enabled) throw new HttpError(400, 'Teams notifications are not configured ("notify.teams")');
            log('info', `User "${user.upn}" sent a test notification`);
            return this.#json(res, 200, {results: await Notifier.sendTest(user.name || user.upn)});
        }

        throw new HttpError(404, 'Not found');
    }

    /** Full details of a mail: metadata, history, headers and a text preview */
    async #details(id: string)
    {
        const record = Archive.get(id)!;
        const file = Archive.filePath(record);
        let headers: {key: string, value: string}[] = [];
        let body: {text?: string, truncated?: boolean, attachments: {filename?: string, contentType: string, size: number}[]}|undefined;

        if(file)
        {
            try {
                headers = (await readHeaders(file)).map(h=>({key: h.key, value: decodeHeader(h.value) ?? h.value}));
                const parsed = await simpleParser(fs.createReadStream(file), {skipHtmlToText: false, skipTextToHtml: true, skipImageLinks: true});
                const text = parsed.text ?? '';
                body = {
                    text: text.substring(0, 20000),
                    truncated: text.length > 20000,
                    attachments: parsed.attachments.map(a=>({filename: a.filename, contentType: a.contentType, size: a.size})),
                };
            } catch(error) {
                log('warn', `Failed to parse "${id}"`, {error});
            }
        }

        return {record, events: Archive.events(id), headers, body, fileAvailable: Boolean(file)};
    }

    // ---------------- Authentication ----------------

    #getUser(req: http.IncomingMessage): IUser|undefined
    {
        if(!Config.webAuthEnabled) return {name: 'Anonymous', upn: 'anonymous'};

        const sid = this.#cookies(req)[SESSION_COOKIE];
        if(!sid) return undefined;
        const session = this.#sessions.get(sid);
        if(!session || session.expires < Date.now())
        {
            this.#sessions.delete(sid);
            return undefined;
        }
        return session.user;
    }

    async #login(res: http.ServerResponse, url: URL)
    {
        if(!Config.webAuthEnabled) return this.#redirect(res, '/');
        const client = Mailer.msalClient;
        if(!client) throw new HttpError(500, 'No app registration configured');

        const {verifier, challenge} = await this.#crypto.generatePkceCodes();
        const state = randomBytes(24).toString('base64url');
        let returnTo = url.searchParams.get('returnTo') || '/';
        if(!returnTo.startsWith('/') || returnTo.startsWith('//')) returnTo = '/'; // Prevent open redirects

        this.#pendingLogins.set(state, {verifier, returnTo, expires: Date.now() + 10*60*1000});

        const authUrl = await client.getAuthCodeUrl({
            scopes: ['openid', 'profile'],
            redirectUri: this.#redirectUri,
            state,
            codeChallenge: challenge,
            codeChallengeMethod: 'S256',
            responseMode: 'query' as any,
        });
        this.#redirect(res, authUrl);
    }

    async #callback(res: http.ServerResponse, url: URL)
    {
        const client = Mailer.msalClient;
        if(!Config.webAuthEnabled || !client) return this.#redirect(res, '/');

        if(url.searchParams.get('error'))
            return this.#html(res, this.#messagePage('Anmeldung fehlgeschlagen', url.searchParams.get('error_description') || url.searchParams.get('error')!), false, 401);

        const state = url.searchParams.get('state') || '';
        const pending = this.#pendingLogins.get(state);
        this.#pendingLogins.delete(state);
        if(!pending || pending.expires < Date.now())
            return this.#redirect(res, '/auth/login');

        const result = await client.acquireTokenByCode({
            code: url.searchParams.get('code') || '',
            scopes: ['openid', 'profile'],
            redirectUri: this.#redirectUri,
            codeVerifier: pending.verifier,
        });
        // We only need the ID token claims, don't keep the user in MSAL's token cache
        if(result.account) await client.getTokenCache().removeAccount(result.account).catch(()=>{});

        const claims = result.idTokenClaims as Record<string, any>;
        const user: IUser = {
            name: claims.name || result.account?.name || '',
            upn: claims.preferred_username || result.account?.username || claims.oid,
            oid: claims.oid,
        };

        if(!await this.#isAllowed(claims))
        {
            log('warn', `User "${user.upn}" tried to log in, but is not a member of an allowed group`);
            return this.#html(res, this.#messagePage('Kein Zugriff', `Das Konto ${user.upn} ist nicht Mitglied einer berechtigten Gruppe.`), false, 403);
        }

        const sid = randomBytes(32).toString('base64url');
        const maxAge = Config.webSessionHours*60*60;
        this.#sessions.set(sid, {user, expires: Date.now() + maxAge*1000});
        res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${this.#secureCookies?'; Secure':''}`);
        log('info', `User "${user.upn}" logged in`);
        this.#redirect(res, pending.returnTo);
    }

    /** Check membership of an allowed group, using the groups claim or (on group overage) the Graph API */
    async #isAllowed(claims: Record<string, any>): Promise<boolean>
    {
        const allowed = Config.webAllowedGroups;

        if(Array.isArray(claims.groups))
            return claims.groups.some((g: string)=>allowed.includes(String(g).toLowerCase()));

        // No groups claim (not configured) or too many groups (overage): ask the Graph API
        if(!claims.oid) return false;
        try {
            const token = await Mailer.getAppToken();
            const res = await axios.post(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(claims.oid)}/checkMemberGroups`,
                {groupIds: allowed},
                {headers: {Authorization: `Bearer ${token}`}, proxy: Config.httpProxyConfig, timeout: 20000});
            return Array.isArray(res.data?.value) && res.data.value.length > 0;
        } catch(error: any) {
            log('error', `Group membership check via Graph failed. Add the "groups" claim to the token or grant "GroupMember.Read.All"`, {error: error?.response?.data?.error?.message ?? String(error)});
            return false;
        }
    }

    #logout(req: http.IncomingMessage, res: http.ServerResponse)
    {
        const sid = this.#cookies(req)[SESSION_COOKIE];
        if(sid) this.#sessions.delete(sid);
        res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${this.#secureCookies?'; Secure':''}`);
        this.#html(res, this.#messagePage('Abgemeldet', 'Sie wurden abgemeldet.', '/auth/login', 'Erneut anmelden'));
    }

    // ---------------- Helpers ----------------

    #cookies(req: http.IncomingMessage): Record<string, string>
    {
        const out: Record<string, string> = {};
        for(const part of (req.headers.cookie || '').split(';'))
        {
            const idx = part.indexOf('=');
            if(idx > 0) out[part.substring(0, idx).trim()] = part.substring(idx+1).trim();
        }
        return out;
    }

    #num(value: string|null): number|undefined
    {
        if(value === null || value === '' || isNaN(Number(value))) return undefined;
        return Number(value);
    }

    #escape(value: string)
    {
        return value.replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
    }

    #redirect(res: http.ServerResponse, location: string)
    {
        res.statusCode = 302;
        res.setHeader('Location', location);
        res.end();
    }

    #json(res: http.ServerResponse, status: number, data: any)
    {
        res.statusCode = status;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify(data));
    }

    #html(res: http.ServerResponse, html: string, allowTeamsFrame = false, status = 200)
    {
        const nonce = randomBytes(16).toString('base64');
        res.statusCode = status;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Content-Security-Policy', [
            `default-src 'self'`,
            `script-src 'nonce-${nonce}'`,
            `style-src 'nonce-${nonce}'`,
            `img-src 'self' data:`,
            `frame-ancestors ${allowTeamsFrame?'https://teams.microsoft.com https://*.teams.microsoft.com https://*.cloud.microsoft':`'none'`}`,
        ].join('; '));
        res.end(html.replace(/__NONCE__/g, nonce));
    }

    #messagePage(title: string, message: string, link = '/', linkText = 'Zur Startseite')
    {
        return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>SMTP2Graph</title>
<style nonce="__NONCE__">body{font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#1f2328}a{color:#0f6cbd}</style></head>
<body><h1>${this.#escape(title)}</h1><p>${this.#escape(message)}</p><p><a href="${this.#escape(link)}">${this.#escape(linkText)}</a></p></body></html>`;
    }
}
