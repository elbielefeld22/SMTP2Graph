import fs from 'fs';
import readline from 'readline';
import addressparser from 'nodemailer/lib/addressparser';
// @ts-ignore libmime ships without type definitions
import libmime from 'libmime';

export interface IMailHeader
{
    /** Header name in lower case */
    key: string;
    /** Unfolded raw header value */
    value: string;
}

/** Read the (unfolded) header block of an EML file. Stops reading at the first empty line. */
export async function readHeaders(filePath: string): Promise<IMailHeader[]>
{
    const readStream = fs.createReadStream(filePath);
    const reader = readline.createInterface({input: readStream, crlfDelay: Infinity});
    const headers: IMailHeader[] = [];
    let current: string|null = null;

    const flush = ()=>{
        if(current === null) return;
        const idx = current.indexOf(':');
        if(idx > 0) headers.push({key: current.substring(0, idx).trim().toLowerCase(), value: current.substring(idx+1).trim()});
        current = null;
    };

    try {
        for await (const line of reader)
        {
            if(line === '') break; // End of the header block
            else if(/^[ \t]/.test(line)) // Folded continuation line
            {
                if(current !== null) current += ' ' + line.trim();
            }
            else
            {
                flush();
                current = line;
            }
        }
        flush();
    } finally {
        reader.close();
        readStream.destroy();
    }

    return headers;
}

/** Decode RFC 2047 encoded words (=?utf-8?Q?...?=) */
export function decodeHeader(value: string|undefined): string|undefined
{
    if(value === undefined) return undefined;
    try {
        return libmime.decodeWords(value);
    } catch {
        return value;
    }
}

/** Get the first value of a header */
export function getHeader(headers: IMailHeader[], key: string): string|undefined
{
    return headers.find(h=>h.key===key.toLowerCase())?.value;
}

/** Turn an address header into a readable, comma separated list (`Name <address>`) */
export function formatAddressHeader(value: string|undefined): string|undefined
{
    if(!value) return undefined;
    try {
        const parsed = addressparser(value, {flatten: true});
        if(!parsed.length) return decodeHeader(value);
        return parsed.map(a=>{
            const name = decodeHeader(a.name);
            return name?`${name} <${a.address}>`:a.address;
        }).join(', ');
    } catch {
        return decodeHeader(value);
    }
}
