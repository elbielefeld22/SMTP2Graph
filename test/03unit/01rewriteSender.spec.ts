import fs from 'fs';
import os from 'os';
import path from 'path';
import { expect } from 'chai';
import { simpleParser } from 'mailparser';
import '../_config';
import { rewriteSender, ORIGINAL_FROM_HEADER } from '../../src/classes/MailRewrite';

async function readAll(stream: NodeJS.ReadableStream): Promise<string>
{
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
    return Buffer.concat(chunks).toString('utf-8');
}

describe('Unit: Rewrite sender for fallback mailbox', function(){
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smtp2graph-'));
    const file = path.join(dir, 'test.eml');

    // A message with a display name (encoded), a Sender header and an attached message that has its own From header
    const eml = [
        'From: =?utf-8?Q?J=C3=BCrgen_App?= <app@missing.example.com>',
        'Sender: app@missing.example.com',
        'To: receiver@example.com',
        'Subject: Fallback test',
        'MIME-Version: 1.0',
        'Content-Type: multipart/mixed; boundary="b1"',
        '',
        '--b1',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'Body text stays the same',
        '--b1',
        'Content-Type: message/rfc822',
        '',
        'From: inner@example.com',
        'Subject: Inner message',
        '',
        'Inner body',
        '--b1--',
        '',
    ].join('\r\n');

    before(function(){
        fs.writeFileSync(file, eml);
    });

    after(function(){
        fs.rmSync(dir, {recursive: true, force: true});
    });

    it('Replaces From, keeps the display name and the original address', async function(){
        const output = await readAll(rewriteSender(file, 'fallback@example.com'));
        const parsed = await simpleParser(output);

        expect(parsed.from?.value[0].address).to.equal('fallback@example.com');
        expect(parsed.from?.value[0].name).to.equal('Jürgen App');
        expect(parsed.headers.has('sender'), 'Sender header should be removed').to.be.false;
        expect(String(parsed.headers.get(ORIGINAL_FROM_HEADER.toLowerCase()))).to.contain('app@missing.example.com');
        expect(parsed.text).to.contain('Body text stays the same');
    });

    it('Does not touch headers of attached messages', async function(){
        const output = await readAll(rewriteSender(file, 'fallback@example.com'));
        expect(output).to.contain('From: inner@example.com');
        expect(output.match(/^From:/gm)).to.have.length(2);
    });

    it('Leaves the file on disk unchanged', async function(){
        await readAll(rewriteSender(file, 'fallback@example.com'));
        expect(fs.readFileSync(file, 'utf-8')).to.equal(eml);
    });
});
