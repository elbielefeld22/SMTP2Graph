import { expect } from 'chai';
import { randomUUID } from 'crypto';
import '../_config';
import { Server } from '../classes/Server';
import { submitMail } from './Helpers';

const webPort = 8090;
const base = `http://127.0.0.1:${webPort}`;

describe('Receive: Archive and web interface', async function(){
    const server = new Server({
        mode: 'receive',
        archive: {retentionDays: 30},
        web: {
            port: webPort,
            listenAddress: '127.0.0.1',
            auth: {enabled: false},
        },
    });

    before('Start server', async function(){
        await expect(server.start(), 'Failed to start SMTP server').to.eventually.be.fulfilled;
    });

    after('Stop server', async function(){
        await server.stop();
    });

    it('Received mail is archived with SMTP session metadata', async function(){
        const subject = `TEST: archive ${randomUUID()}`;
        await submitMail({mail: {subject, cc: 'cc@example.com'}});

        const list = await (await fetch(`${base}/api/mails?q=${encodeURIComponent(subject)}`)).json();
        expect(list.total, 'Mail not found in archive').to.equal(1);

        const mail = list.items[0];
        expect(mail.subject).to.equal(subject);
        expect(mail.status).to.equal('queued');
        expect(mail.remoteIp).to.match(/127\.0\.0\.1/);
        expect(mail.envelopeFrom).to.equal('noreply@example.com');
        expect(mail.envelopeTo).to.contain('receiver@example.com');
        expect(mail.headerCc).to.equal('cc@example.com');
        expect(mail.size).to.be.greaterThan(0);

        const details = await (await fetch(`${base}/api/mails/${encodeURIComponent(mail.id)}`)).json();
        expect(details.events.map((e: any)=>e.type)).to.include('received');
    });

    it('Search filters by status', async function(){
        const subject = `TEST: status ${randomUUID()}`;
        await submitMail({mail: {subject}});

        const failed = await (await fetch(`${base}/api/mails?status=failed&q=${encodeURIComponent(subject)}`)).json();
        expect(failed.total).to.equal(0);
        const queued = await (await fetch(`${base}/api/mails?status=queued&q=${encodeURIComponent(subject)}`)).json();
        expect(queued.total).to.equal(1);
    });

    it('Only failed mails can be resent', async function(){
        const subject = `TEST: resend ${randomUUID()}`;
        await submitMail({mail: {subject}});
        const list = await (await fetch(`${base}/api/mails?q=${encodeURIComponent(subject)}`)).json();

        const res = await fetch(`${base}/api/mails/${encodeURIComponent(list.items[0].id)}/resend`, {method: 'POST', headers: {'X-SMTP2Graph': '1'}});
        expect(res.status).to.equal(409);
    });

    it('POST requests without CSRF header are rejected', async function(){
        const res = await fetch(`${base}/api/notify/test`, {method: 'POST'});
        expect(res.status).to.equal(403);
    });

    it('Statistics are available', async function(){
        const stats = await (await fetch(`${base}/api/stats?days=7`)).json();
        expect(stats.perDay).to.have.length(7);
        expect(stats.totals.total).to.be.greaterThan(0);
    });

    it('Web interface is served', async function(){
        const res = await fetch(`${base}/`);
        expect(res.status).to.equal(200);
        expect(res.headers.get('content-security-policy')).to.contain(`frame-ancestors 'none'`);
        expect(await res.text()).to.contain('SMTP2Graph');
    });
});

describe('Receive: Web interface login', async function(){
    const server = new Server({
        mode: 'receive',
        send: {appReg: {tenant: 'contoso', id: '01234567-89ab-cdef-0123-456789abcdef', secret: 'not-a-real-secret'}},
        archive: {},
        web: {
            port: webPort,
            listenAddress: '127.0.0.1',
            publicUrl: base,
            auth: {allowedGroups: ['01234567-89ab-cdef-0123-456789abcdef']},
        },
    });

    before('Start server', async function(){
        await expect(server.start(), 'Failed to start SMTP server').to.eventually.be.fulfilled;
    });

    after('Stop server', async function(){
        await server.stop();
    });

    it('API requires login', async function(){
        const res = await fetch(`${base}/api/mails`);
        expect(res.status).to.equal(401);
    });

    it('Page redirects to login', async function(){
        const res = await fetch(`${base}/`, {redirect: 'manual'});
        expect(res.status).to.equal(302);
        expect(res.headers.get('location')).to.match(/^\/auth\/login/);
    });

    it('Login redirects to Entra ID with PKCE', async function(){
        const res = await fetch(`${base}/auth/login`, {redirect: 'manual'});
        expect(res.status).to.equal(302);
        const location = new URL(res.headers.get('location')!);
        expect(location.host).to.equal('login.microsoftonline.com');
        expect(location.searchParams.get('code_challenge_method')).to.equal('S256');
        expect(location.searchParams.get('redirect_uri')).to.equal(`${base}/auth/callback`);
    });

    it('Callback with unknown state does not log in', async function(){
        const res = await fetch(`${base}/auth/callback?code=x&state=unknown`, {redirect: 'manual'});
        expect(res.status).to.equal(302);
        expect(res.headers.get('set-cookie')).to.be.null;
    });

    it('Teams landing page is public and frameable by Teams', async function(){
        const res = await fetch(`${base}/teams`);
        expect(res.status).to.equal(200);
        expect(res.headers.get('content-security-policy')).to.contain('https://teams.microsoft.com');
    });
});
