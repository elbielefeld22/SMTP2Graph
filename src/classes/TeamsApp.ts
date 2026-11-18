import zlib from 'zlib';
import { Config } from './Config';

/**
 * Builds the Teams app package (manifest.json + icons, zipped) that is needed
 * to send activity feed notifications and that adds a personal "SMTP2Graph" tab.
 */
export class TeamsApp
{
    /** Returns a list of problems that prevent building a usable package */
    static problems(): string[]
    {
        const problems: string[] = [];
        if(!Config.clientId) problems.push('"send.appReg.id" is not configured');
        if(!Config.notifyTeams?.teamsAppId) problems.push('"notify.teams.teamsAppId" is not configured');
        if(!Config.webPublicUrl?.startsWith('https://')) problems.push('"web.publicUrl" must be an https:// URL (required by Teams)');
        return problems;
    }

    static manifest()
    {
        const publicUrl = Config.webPublicUrl!;
        const host = new URL(publicUrl).host;

        return {
            $schema: 'https://developer.microsoft.com/en-us/json-schemas/teams/v1.17/MicrosoftTeams.schema.json',
            manifestVersion: '1.17',
            version: VERSION.replace(/[^\d.]/g, '') || '1.0.0',
            id: Config.notifyTeams!.teamsAppId,
            developer: {
                name: 'SMTP2Graph',
                websiteUrl: publicUrl + '/',
                privacyUrl: publicUrl + '/',
                termsOfUseUrl: publicUrl + '/',
            },
            name: {short: 'SMTP2Graph', full: 'SMTP2Graph Mail-Relay'},
            description: {
                short: 'Benachrichtigungen über fehlgeschlagene Mails',
                full: 'Benachrichtigt über Mails, die SMTP2Graph nicht über Microsoft Graph versenden konnte, und verlinkt auf die Weboberfläche mit Suche, Statistik und erneutem Senden.',
            },
            icons: {color: 'color.png', outline: 'outline.png'},
            accentColor: '#0F6CBD',
            staticTabs: [{
                entityId: 'smtp2graph',
                name: 'SMTP2Graph',
                contentUrl: publicUrl + '/teams',
                websiteUrl: publicUrl + '/',
                scopes: ['personal'],
            }],
            permissions: ['identity'],
            validDomains: [host],
            // Links this Teams app to our app registration, required for sendActivityNotification
            webApplicationInfo: {id: Config.clientId},
        };
    }

    /** The zipped app package */
    static package(): Buffer
    {
        return this.#zip([
            {name: 'manifest.json', data: Buffer.from(JSON.stringify(this.manifest(), null, 2))},
            {name: 'color.png', data: this.#icon(192, false)},
            {name: 'outline.png', data: this.#icon(32, true)},
        ]);
    }

    /** Draw an envelope icon. Color: white envelope on blue. Outline: white envelope lines on transparent */
    static #icon(size: number, outline: boolean): Buffer
    {
        const px = Buffer.alloc(size*size*4);
        const set = (x: number, y: number, r: number, g: number, b: number, a = 255)=>{
            const i = (y*size + x)*4;
            px[i] = r; px[i+1] = g; px[i+2] = b; px[i+3] = a;
        };

        const m = Math.round(size*(outline?0.12:0.22)); // Margin
        const top = Math.round(size*(outline?0.25:0.32)), bottom = size - top;
        const left = m, right = size - m - 1;
        const stroke = Math.max(1, Math.round(size/(outline?16:24)));
        const midX = (left + right)/2, flapY = top + (bottom-top)*0.55;

        for(let y=0; y<size; y++)
        {
            for(let x=0; x<size; x++)
            {
                const inside = x>=left && x<=right && y>=top && y<=bottom;
                const border = inside && (x-left<stroke || right-x<stroke || y-top<stroke || bottom-y<stroke);
                // Distance to the two flap lines (from the top corners to the middle)
                const t = (x<=midX)?(x-left)/(midX-left):(right-x)/(right-midX);
                const flapLineY = top + t*(flapY-top);
                const flap = inside && Math.abs(y-flapLineY) < stroke*0.9;

                if(outline)
                {
                    if(border || flap) set(x, y, 255, 255, 255);
                }
                else
                {
                    if(inside) (flap?set(x, y, 0x0F, 0x6C, 0xBD):set(x, y, 255, 255, 255));
                    else set(x, y, 0x0F, 0x6C, 0xBD);
                }
            }
        }

        // Encode as PNG (RGBA, filter 0 per row)
        const raw = Buffer.alloc((size*4+1)*size);
        for(let y=0; y<size; y++) px.copy(raw, y*(size*4+1)+1, y*size*4, (y+1)*size*4);

        const chunk = (type: string, data: Buffer)=>{
            const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
            const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
            const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td));
            return Buffer.concat([len, td, crc]);
        };
        const ihdr = Buffer.alloc(13);
        ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
        ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

        return Buffer.concat([
            Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
            chunk('IHDR', ihdr),
            chunk('IDAT', zlib.deflateSync(raw)),
            chunk('IEND', Buffer.alloc(0)),
        ]);
    }

    /** Minimal ZIP writer (deflate) */
    static #zip(files: {name: string, data: Buffer}[]): Buffer
    {
        const locals: Buffer[] = [];
        const centrals: Buffer[] = [];
        let offset = 0;

        for(const file of files)
        {
            const name = Buffer.from(file.name, 'utf-8');
            const compressed = zlib.deflateRawSync(file.data);
            const crc = zlib.crc32(file.data);

            const local = Buffer.alloc(30);
            local.writeUInt32LE(0x04034b50, 0);
            local.writeUInt16LE(20, 4);   // Version needed
            local.writeUInt16LE(0x0800, 6); // UTF-8 names
            local.writeUInt16LE(8, 8);    // Deflate
            local.writeUInt16LE(0, 10);   // Time
            local.writeUInt16LE(0x21, 12); // Date (1980-01-01)
            local.writeUInt32LE(crc, 14);
            local.writeUInt32LE(compressed.length, 18);
            local.writeUInt32LE(file.data.length, 22);
            local.writeUInt16LE(name.length, 26);
            local.writeUInt16LE(0, 28);
            locals.push(local, name, compressed);

            const central = Buffer.alloc(46);
            central.writeUInt32LE(0x02014b50, 0);
            central.writeUInt16LE(20, 4);
            central.writeUInt16LE(20, 6);
            central.writeUInt16LE(0x0800, 8);
            central.writeUInt16LE(8, 10);
            central.writeUInt16LE(0, 12);
            central.writeUInt16LE(0x21, 14);
            central.writeUInt32LE(crc, 16);
            central.writeUInt32LE(compressed.length, 20);
            central.writeUInt32LE(file.data.length, 24);
            central.writeUInt16LE(name.length, 28);
            central.writeUInt32LE(offset, 42);
            centrals.push(central, name);

            offset += local.length + name.length + compressed.length;
        }

        const centralBuf = Buffer.concat(centrals);
        const end = Buffer.alloc(22);
        end.writeUInt32LE(0x06054b50, 0);
        end.writeUInt16LE(files.length, 8);
        end.writeUInt16LE(files.length, 10);
        end.writeUInt32LE(centralBuf.length, 12);
        end.writeUInt32LE(offset, 16);

        return Buffer.concat([...locals, centralBuf, end]);
    }
}
