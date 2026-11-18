import fs from 'fs';
import { Readable } from 'stream';
import addressparser from 'nodemailer/lib/addressparser';
// @ts-ignore libmime ships without type definitions
import libmime from 'libmime';
const Splitter = require('mailsplit').Splitter;
const Joiner = require('mailsplit').Joiner;

/** Header that keeps the original From address when the sender was replaced */
export const ORIGINAL_FROM_HEADER = 'X-SMTP2Graph-Original-From';

/** Build an address header value, keeping a (possibly non-ASCII) display name */
export function formatAddress(address: string, name?: string): string
{
    if(!name) return address;
    const encoded = /[^\x20-\x7e]/.test(name)
        ? libmime.encodeWords(name, 'Q', 52)
        : `"${name.replace(/(["\\])/g, '\\$1')}"`;
    return `${encoded} <${address}>`;
}

/**
 * Read an EML file and replace the sender: the From header is set to `newFrom` (keeping the display name),
 * a Sender header is removed and the original From is kept in `X-SMTP2Graph-Original-From`.
 * The file on disk is not modified.
 */
export function rewriteSender(filePath: string, newFrom: string): Readable
{
    const splitter = new Splitter();
    let rootDone = false;

    splitter.on('data', (data: any)=>{
        if(data.type !== 'node' || rootDone) return;
        rootDone = true; // Only the headers of the message itself, not of the MIME parts

        const originalFrom: string|undefined = data.headers.getFirst('From') || undefined; // Unfolded value
        let name: string|undefined;
        if(originalFrom)
        {
            try {
                const parsed = addressparser(originalFrom, {flatten: true});
                name = parsed[0]?.name?libmime.decodeWords(parsed[0].name):undefined;
            } catch { /* keep without name */ }
            data.headers.remove(ORIGINAL_FROM_HEADER);
            data.headers.add(ORIGINAL_FROM_HEADER, originalFrom);
        }

        data.headers.remove('Sender');
        data.headers.remove('From');
        data.headers.add('From', formatAddress(newFrom, name));
    });

    const output = fs.createReadStream(filePath).pipe(splitter).pipe(new Joiner());
    return output as Readable;
}
