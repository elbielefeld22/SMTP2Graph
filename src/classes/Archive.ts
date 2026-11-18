import fs from 'fs';
import path from 'path';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { Config } from './Config';
import { prefixedLog } from './Logger';
import { readHeaders, getHeader, decodeHeader, formatAddressHeader } from './MailHeaders';
import type { ISendResult } from './Mailer';

const log = prefixedLog('Archive');

export type MailStatus = 'queued'|'retrying'|'sent'|'failed';
/** Folder (inside mailroot) where the EML file currently lives */
export type MailLocation = 'queue'|'archive'|'failed'|'deleted';

export interface IReceiveMeta
{
    remoteIp?: string;
    clientHostname?: string;
    smtpUser?: string;
    tls?: boolean;
    envelopeFrom?: string;
    envelopeTo?: string[];
}

export interface IMailRecord
{
    id: string;
    receivedAt: number;
    remoteIp: string|null;
    clientHostname: string|null;
    smtpUser: string|null;
    tls: boolean|null;
    envelopeFrom: string|null;
    envelopeTo: string|null;
    headerFrom: string|null;
    headerTo: string|null;
    headerCc: string|null;
    subject: string|null;
    messageId: string|null;
    size: number|null;
    status: MailStatus;
    attempts: number;
    lastError: string|null;
    lastAttemptAt: number|null;
    sentAt: number|null;
    senderMailbox: string|null;
    /** Set when the fallback mailbox was used: the original sending mailbox that doesn't exist */
    fallbackFor: string|null;
    location: MailLocation;
    resentCount: number;
}

export interface IMailEvent
{
    at: number;
    type: 'received'|'attempt'|'sent'|'error'|'failed'|'resend'|'fallback';
    message: string|null;
}

interface IParsedFile
{
    from?: string;
    to?: string;
    cc?: string;
    subject?: string;
    messageId?: string;
    size: number;
}

export interface ISearchOptions
{
    q?: string;
    status?: MailStatus;
    /** Only mails sent from the fallback mailbox */
    fallback?: boolean;
    from?: number;
    to?: number;
    limit?: number;
    offset?: number;
}

/**
 * Keeps metadata of every received mail in a SQLite database (`mailroot/smtp2graph.db`)
 * and keeps the EML files for `archive.retentionDays` days.
 * All methods are no-ops when the archive is disabled in the config.
 */
export class Archive
{
    static #db: DatabaseSync|undefined;
    static #rootPath = 'mailroot';
    static #cleanupTimer: NodeJS.Timeout|undefined;
    static #stmts: Record<string, StatementSync> = {};

    static get enabled(): boolean
    {
        return Config.archiveEnabled;
    }

    /** Open (and create/migrate) the database. Safe to call multiple times */
    static init(rootPath = 'mailroot')
    {
        if(!this.enabled || this.#db) return;
        this.#rootPath = rootPath;

        const archiveDir = path.join(rootPath, 'archive');
        if(!fs.existsSync(rootPath)) fs.mkdirSync(rootPath);
        if(!fs.existsSync(archiveDir)) fs.mkdirSync(archiveDir);

        // Loaded lazily, so the ExperimentalWarning filter in server.ts is active before the module loads
        const { DatabaseSync: Database } = require('node:sqlite') as typeof import('node:sqlite');
        const db = new Database(path.join(rootPath, 'smtp2graph.db'));
        // WAL allows a 'receive' and a 'send' instance to share the database
        db.exec(`
            PRAGMA journal_mode = WAL;
            PRAGMA busy_timeout = 5000;
            PRAGMA foreign_keys = ON;
            CREATE TABLE IF NOT EXISTS mails (
                id TEXT PRIMARY KEY,
                received_at INTEGER NOT NULL,
                remote_ip TEXT,
                client_hostname TEXT,
                smtp_user TEXT,
                tls INTEGER,
                envelope_from TEXT,
                envelope_to TEXT,
                header_from TEXT,
                header_to TEXT,
                header_cc TEXT,
                subject TEXT,
                message_id TEXT,
                size INTEGER,
                status TEXT NOT NULL,
                attempts INTEGER NOT NULL DEFAULT 0,
                last_error TEXT,
                last_attempt_at INTEGER,
                sent_at INTEGER,
                sender_mailbox TEXT,
                location TEXT NOT NULL,
                resent_count INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_mails_received ON mails(received_at);
            CREATE INDEX IF NOT EXISTS idx_mails_status ON mails(status);
            CREATE TABLE IF NOT EXISTS events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                mail_id TEXT NOT NULL REFERENCES mails(id) ON DELETE CASCADE,
                at INTEGER NOT NULL,
                type TEXT NOT NULL,
                message TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_events_mail ON events(mail_id);
        `);

        // Migrations for databases created by older versions
        const columns = (db.prepare('PRAGMA table_info(mails)').all() as {name: string}[]).map(c=>c.name);
        if(!columns.includes('fallback_for')) db.exec('ALTER TABLE mails ADD COLUMN fallback_for TEXT');
        this.#db = db;
        this.#stmts = {};

        log('info', `Archive enabled (retention: ${Config.archiveRetentionDays} days, store content: ${Config.archiveStoreContent})`);

        // Cleanup now and every hour
        this.cleanup();
        this.#cleanupTimer = setInterval(()=>this.cleanup(), 60*60*1000);
        this.#cleanupTimer.unref();
    }

    static close()
    {
        if(this.#cleanupTimer) clearInterval(this.#cleanupTimer);
        this.#cleanupTimer = undefined;
        this.#db?.close();
        this.#db = undefined;
        this.#stmts = {};
    }

    static get rootPath()
    {
        return this.#rootPath;
    }

    /** Absolute path of the EML file for a record, or undefined when it no longer exists */
    static filePath(record: Pick<IMailRecord, 'id'|'location'>): string|undefined
    {
        if(record.location === 'deleted') return undefined;
        const file = path.join(this.#rootPath, record.location, record.id);
        return fs.existsSync(file)?file:undefined;
    }

    static #stmt(sql: string): StatementSync
    {
        if(!this.#db) throw new Error('Archive is not initialized');
        return this.#stmts[sql] ??= this.#db.prepare(sql);
    }

    static #safe<T>(action: string, fn: ()=>T): T|undefined
    {
        if(!this.enabled || !this.#db) return undefined;
        try {
            return fn();
        } catch(error) {
            log('error', `Failed to ${action}`, {error});
        }
    }

    static #event(id: string, type: IMailEvent['type'], message?: string|null)
    {
        this.#stmt('INSERT INTO events (mail_id, at, type, message) VALUES (?, ?, ?, ?)').run(id, Date.now(), type, message ?? null);
    }

    /** Register a newly received mail. The file name is used as ID */
    static async recordReceived(filePath: string, meta: IReceiveMeta = {})
    {
        if(!this.enabled || !this.#db) return;
        const id = path.basename(filePath);

        let headerData: IParsedFile|undefined;
        try {
            headerData = await this.#parseFile(filePath);
        } catch(error) {
            log('warn', `Failed to read headers of "${id}"`, {error});
        }

        this.#safe('record received mail', ()=>{
            this.#stmt(`INSERT INTO mails (id, received_at, remote_ip, client_hostname, smtp_user, tls, envelope_from, envelope_to,
                    header_from, header_to, header_cc, subject, message_id, size, status, location)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 'queue')
                ON CONFLICT(id) DO NOTHING`).run(
                id, Date.now(),
                meta.remoteIp ?? null, meta.clientHostname ?? null, meta.smtpUser ?? null,
                meta.tls === undefined?null:(meta.tls?1:0),
                meta.envelopeFrom ?? null, meta.envelopeTo?.join(', ') ?? null,
                headerData?.from ?? null, headerData?.to ?? null, headerData?.cc ?? null,
                headerData?.subject ?? null, headerData?.messageId ?? null, headerData?.size ?? null,
            );
            this.#event(id, 'received', meta.remoteIp?`From ${meta.remoteIp}`:null);
        });
    }

    /** Make sure a record exists for a file found in the queue (e.g. dropped there by another tool) */
    static async ensureRecord(filePath: string)
    {
        if(!this.enabled || !this.#db) return;
        if(!this.get(path.basename(filePath)))
            await this.recordReceived(filePath);
    }

    static async #parseFile(filePath: string): Promise<IParsedFile>
    {
        const headers = await readHeaders(filePath);
        return {
            from: formatAddressHeader(getHeader(headers, 'from')),
            to: formatAddressHeader(getHeader(headers, 'to')),
            cc: formatAddressHeader(getHeader(headers, 'cc')),
            subject: decodeHeader(getHeader(headers, 'subject')),
            messageId: getHeader(headers, 'message-id'),
            size: fs.statSync(filePath).size,
        };
    }

    static markAttempt(id: string)
    {
        this.#safe('mark attempt', ()=>{
            this.#stmt(`UPDATE mails SET attempts = attempts + 1, last_attempt_at = ? WHERE id = ?`).run(Date.now(), id);
        });
    }

    static markSent(id: string, result: ISendResult, location: MailLocation)
    {
        this.#safe('mark sent', ()=>{
            this.#stmt(`UPDATE mails SET status = 'sent', sent_at = ?, sender_mailbox = ?, fallback_for = ?, last_error = NULL, location = ? WHERE id = ?`)
                .run(Date.now(), result.mailbox, result.fallbackFor ?? null, location, id);
            if(result.fallbackFor)
                this.#event(id, 'fallback', `Mailbox ${result.fallbackFor} does not exist, sent from fallback mailbox ${result.mailbox} (From header replaced)`);
            this.#event(id, 'sent', `Accepted by Graph (mailbox ${result.mailbox})`);
        });
    }

    static markRetrying(id: string, error: string)
    {
        this.#safe('mark retrying', ()=>{
            this.#stmt(`UPDATE mails SET status = 'retrying', last_error = ? WHERE id = ?`).run(error, id);
            this.#event(id, 'error', error);
        });
    }

    static markFailed(id: string, error: string, location: MailLocation)
    {
        this.#safe('mark failed', ()=>{
            this.#stmt(`UPDATE mails SET status = 'failed', last_error = ?, location = ? WHERE id = ?`).run(error, location, id);
            this.#event(id, 'failed', error);
        });
    }

    static markResent(id: string, by?: string)
    {
        this.#safe('mark resent', ()=>{
            this.#stmt(`UPDATE mails SET status = 'queued', location = 'queue', resent_count = resent_count + 1 WHERE id = ?`).run(id);
            this.#event(id, 'resend', by?`Resend requested by ${by}`:'Resend requested');
        });
    }

    static addEvent(id: string, type: IMailEvent['type'], message?: string)
    {
        this.#safe('add event', ()=>this.#event(id, type, message));
    }

    static setLocation(id: string, location: MailLocation)
    {
        this.#safe('set location', ()=>{
            this.#stmt(`UPDATE mails SET location = ? WHERE id = ?`).run(location, id);
        });
    }

    static get(id: string): IMailRecord|undefined
    {
        return this.#safe('get mail', ()=>{
            const row = this.#stmt('SELECT * FROM mails WHERE id = ?').get(id);
            return row?this.#toRecord(row):undefined;
        });
    }

    static events(id: string): IMailEvent[]
    {
        return this.#safe('get events', ()=>
            this.#stmt('SELECT at, type, message FROM events WHERE mail_id = ? ORDER BY id').all(id) as unknown as IMailEvent[]
        ) ?? [];
    }

    static search(opts: ISearchOptions): {total: number, items: IMailRecord[]}
    {
        return this.#safe('search', ()=>{
            const where: string[] = [];
            const params: (string|number)[] = [];

            if(opts.q)
            {
                const like = `%${opts.q.replace(/[\\%_]/g, m=>'\\'+m)}%`;
                const cols = ['id','subject','header_from','header_to','header_cc','envelope_from','envelope_to','remote_ip','client_hostname','smtp_user','message_id','sender_mailbox','fallback_for','last_error'];
                where.push('(' + cols.map(c=>`${c} LIKE ? ESCAPE '\\'`).join(' OR ') + ')');
                params.push(...cols.map(()=>like));
            }
            if(opts.status) { where.push('status = ?'); params.push(opts.status); }
            if(opts.fallback) where.push('fallback_for IS NOT NULL');
            if(opts.from) { where.push('received_at >= ?'); params.push(opts.from); }
            if(opts.to) { where.push('received_at <= ?'); params.push(opts.to); }

            const whereSql = where.length?`WHERE ${where.join(' AND ')}`:'';
            const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
            const offset = Math.max(opts.offset ?? 0, 0);

            // Not using the statement cache: the SQL is dynamic
            const total = (this.#db!.prepare(`SELECT COUNT(*) AS c FROM mails ${whereSql}`).get(...params) as {c: number}).c;
            const rows = this.#db!.prepare(`SELECT * FROM mails ${whereSql} ORDER BY received_at DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);

            return {total, items: rows.map(r=>this.#toRecord(r))};
        }) ?? {total: 0, items: []};
    }

    /** Aggregated numbers for the dashboard */
    static stats(days = 30)
    {
        return this.#safe('get stats', ()=>{
            const since = new Date();
            since.setHours(0, 0, 0, 0);
            since.setDate(since.getDate() - (days-1));
            const s = since.getTime();

            const perDay = this.#db!.prepare(`
                SELECT date(received_at/1000, 'unixepoch', 'localtime') AS day,
                    SUM(status = 'sent') AS sent, SUM(status = 'failed') AS failed,
                    SUM(status IN ('queued','retrying')) AS pending, COUNT(*) AS total
                FROM mails WHERE received_at >= ? GROUP BY day ORDER BY day`).all(s) as {day: string, sent: number, failed: number, pending: number, total: number}[];

            const totals = this.#db!.prepare(`
                SELECT COUNT(*) AS total, SUM(status = 'sent') AS sent, SUM(status = 'failed') AS failed,
                    SUM(status IN ('queued','retrying')) AS pending, SUM(attempts > 1) AS retried,
                    SUM(fallback_for IS NOT NULL) AS fallback,
                    COALESCE(SUM(size), 0) AS bytes,
                    AVG(CASE WHEN sent_at IS NOT NULL THEN sent_at - received_at END) AS avgDeliveryMs
                FROM mails WHERE received_at >= ?`).get(s);

            const top = (col: string, extraWhere = '')=>this.#db!.prepare(`
                SELECT ${col} AS key, COUNT(*) AS count FROM mails
                WHERE received_at >= ? AND ${col} IS NOT NULL ${extraWhere}
                GROUP BY ${col} ORDER BY count DESC LIMIT 10`).all(s);

            // Fill missing days so the chart has a continuous x-axis
            const filled: typeof perDay = [];
            for(let i=0; i<days; i++)
            {
                const d = new Date(since);
                d.setDate(d.getDate()+i);
                const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
                filled.push(perDay.find(p=>p.day===key) ?? {day: key, sent: 0, failed: 0, pending: 0, total: 0});
            }

            return {
                days,
                totals,
                perDay: filled,
                topSenders: top('envelope_from'),
                topIps: top('remote_ip'),
                topErrors: this.#topErrors(s),
            };
        });
    }

    /** Group errors, ignoring the parts that differ per occurrence (IDs, timestamps) */
    static #topErrors(since: number)
    {
        const rows = this.#db!.prepare(`SELECT last_error AS e FROM mails WHERE received_at >= ? AND status = 'failed' AND last_error IS NOT NULL`).all(since) as {e: string}[];
        const counts = new Map<string, number>();
        for(const {e} of rows)
        {
            const key = normalizeError(e);
            counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        return [...counts].sort((a, b)=>b[1]-a[1]).slice(0, 10).map(([key, count])=>({key, count}));
    }

    /** Delete mails (files + metadata) older than the retention period */
    static cleanup()
    {
        this.#safe('cleanup archive', ()=>{
            const cutoff = Date.now() - Config.archiveRetentionDays*24*60*60*1000;
            const old = this.#stmt(`SELECT id, location FROM mails WHERE received_at < ? AND location != 'queue'`).all(cutoff) as {id: string, location: MailLocation}[];

            for(const rec of old)
            {
                const file = this.filePath(rec);
                if(file)
                {
                    try {
                        fs.unlinkSync(file);
                    } catch(error) {
                        log('warn', `Failed to delete "${file}"`, {error});
                        continue; // Keep the record, retry next time
                    }
                }
                this.#stmt('DELETE FROM mails WHERE id = ?').run(rec.id);
            }

            // Remove orphaned files in the archive folder
            const archiveDir = path.join(this.#rootPath, 'archive');
            let orphans = 0;
            for(const file of fs.readdirSync(archiveDir))
            {
                const full = path.join(archiveDir, file);
                try {
                    if(fs.statSync(full).mtimeMs < cutoff) { fs.unlinkSync(full); orphans++; }
                } catch { /* ignore */ }
            }

            if(old.length || orphans) log('info', `Retention cleanup removed ${old.length} mail(s) and ${orphans} orphaned file(s)`);
        });
    }

    static #toRecord(row: any): IMailRecord
    {
        return {
            id: row.id,
            receivedAt: row.received_at,
            remoteIp: row.remote_ip,
            clientHostname: row.client_hostname,
            smtpUser: row.smtp_user,
            tls: row.tls === null?null:Boolean(row.tls),
            envelopeFrom: row.envelope_from,
            envelopeTo: row.envelope_to,
            headerFrom: row.header_from,
            headerTo: row.header_to,
            headerCc: row.header_cc,
            subject: row.subject,
            messageId: row.message_id,
            size: row.size,
            status: row.status,
            attempts: row.attempts,
            lastError: row.last_error,
            lastAttemptAt: row.last_attempt_at,
            sentAt: row.sent_at,
            senderMailbox: row.sender_mailbox,
            fallbackFor: row.fallback_for ?? null,
            location: row.location,
            resentCount: row.resent_count,
        };
    }
}

/** Remove variable parts (GUIDs, timestamps, trace/correlation IDs) from an error message */
export function normalizeError(error: string): string
{
    return error
        .replace(/\s*-?\s*(Timestamp|Trace ID|Correlation ID):\s*[^\s]+(\s+[\d:.]+Z)?/gi, '')
        .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '…')
        .replace(/\s{2,}/g, ' ')
        .trim()
        .substring(0, 300);
}
