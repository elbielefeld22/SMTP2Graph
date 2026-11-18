import fs from 'fs';
import net from 'net';
import { expect } from 'chai';
import '../_config';
import { Server } from '../classes/Server';
import { defaultTransportOptions } from './Helpers';

const webPort = 8090;
const base = `http://127.0.0.1:${webPort}`;
const configFile = 'testconfig.yml';

function postSettings(changes: Record<string, unknown>, csrf = true)
{
    return fetch(`${base}/api/settings`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json', ...(csrf?{'X-SMTP2Graph': '1'}:{})},
        body: JSON.stringify({changes}),
    });
}

/** Read the SMTP greeting and the SIZE extension */
function smtpGreeting(): Promise<{banner: string, size: string}>
{
    return new Promise((resolve, reject)=>{
        const socket = net.connect(defaultTransportOptions.port!, '127.0.0.1');
        let banner = '';
        socket.once('data', data=>{
            banner = data.toString().trim();
            socket.write('EHLO test\r\n');
            socket.once('data', ehlo=>{
                const size = ehlo.toString().split('\r\n').find(l=>/SIZE/.test(l)) ?? '';
                socket.end();
                resolve({banner, size});
            });
        });
        socket.on('error', reject);
    });
}

describe('Receive: Settings in the web interface', async function(){
    const server = new Server({
        mode: 'receive',
        archive: {},
        web: {port: webPort, listenAddress: '127.0.0.1', auth: {enabled: false}},
    });

    before('Start server', async function(){
        await expect(server.start(), 'Failed to start SMTP server').to.eventually.be.fulfilled;
    });

    after('Stop server', async function(){
        await server.stop();
        for(const f of [`${configFile}.bak`, `${configFile}.tmp`]) if(fs.existsSync(f)) fs.unlinkSync(f);
    });

    it('Lists only safe settings', async function(){
        const data = await (await fetch(`${base}/api/settings`)).json();
        const keys = data.settings.map((s: any)=>s.key);
        expect(keys).to.include.members(['send.retryLimit', 'send.fallbackMailbox', 'receive.banner', 'archive.retentionDays']);
        expect(keys).to.not.include.members(['receive.port', 'web.port', 'web.auth.allowedGroups', 'receive.ipWhitelist']);
    });

    it('Rejects invalid values without touching config.yml', async function(){
        const before = fs.readFileSync(configFile, 'utf-8');
        const res = await postSettings({'send.retryLimit': -1, 'receive.maxSize': '500m', 'send.fallbackMailbox': 'no-address'});
        expect(res.status).to.equal(400);
        const data = await res.json();
        expect(Object.keys(data.fieldErrors)).to.have.members(['send.retryLimit', 'receive.maxSize', 'send.fallbackMailbox']);
        expect(fs.readFileSync(configFile, 'utf-8')).to.equal(before);
    });

    it('Rejects settings that are not editable', async function(){
        const before = fs.readFileSync(configFile, 'utf-8');
        const res = await postSettings({'web.port': 1234, 'web.auth.allowedGroups': []});
        expect(res.status).to.equal(400);
        expect(fs.readFileSync(configFile, 'utf-8')).to.equal(before);
    });

    it('Requires the CSRF header', async function(){
        const res = await postSettings({'receive.banner': 'X'}, false);
        expect(res.status).to.equal(403);
    });

    it('Saves valid settings and applies them without restart', async function(){
        const res = await postSettings({'receive.banner': 'Test Relay', 'receive.maxSize': '20m', 'send.retryLimit': 4});
        expect(res.status).to.equal(200);
        const data = await res.json();
        expect(data.changed.map((c: any)=>c.key)).to.have.members(['receive.banner', 'receive.maxSize', 'send.retryLimit']);

        const file = fs.readFileSync(configFile, 'utf-8');
        expect(file).to.contain('banner: Test Relay');
        expect(file).to.contain('maxSize: 20m');
        expect(fs.existsSync(`${configFile}.bak`), 'Backup missing').to.be.true;

        const smtp = await smtpGreeting();
        expect(smtp.banner).to.contain('Test Relay');
        expect(smtp.size).to.contain(String(20*1024*1024));
    });

    it('Clearing an optional setting removes it from config.yml', async function(){
        const res = await postSettings({'receive.banner': ''});
        expect(res.status).to.equal(200);
        expect(fs.readFileSync(configFile, 'utf-8')).to.not.contain('banner:');
        expect((await smtpGreeting()).banner).to.contain('SMTP2Graph');
    });

    it('Changes are listed in the history', async function(){
        const data = await (await fetch(`${base}/api/settings`)).json();
        expect(data.history.map((h: any)=>h.key)).to.include.members(['receive.banner', 'receive.maxSize', 'send.retryLimit']);
    });

    it('Mail list supports the pending and retried filters', async function(){
        expect((await fetch(`${base}/api/mails?status=pending`)).status).to.equal(200);
        expect((await fetch(`${base}/api/mails?retried=1`)).status).to.equal(200);
    });
});
