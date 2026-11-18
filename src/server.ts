import { Config } from './classes/Config';
import { log } from './classes/Logger';
import { MailQueue } from './classes/MailQueue';
import { SMTPServer } from './classes/SMTPServer';
import { WebServer } from './classes/WebServer';
import { Archive } from './classes/Archive';

// node:sqlite still prints an ExperimentalWarning, which is just noise for our users
const emitWarning = process.emitWarning;
process.emitWarning = function(warning: any, ...args: any[])
{
    if(String((warning as any)?.message ?? warning).includes('SQLite is an experimental feature')) return;
    return (emitWarning as any).call(process, warning, ...args);
} as typeof process.emitWarning;

if(process.argv.includes('-v') || process.argv.includes('--version')) // We're asked for our version?
    console.log(`SMTP2Graph v${VERSION}`);
else
{
    (async ()=>{
        // Validate the config before continuing
        try {
            Config.validate();
        } catch(error) {
            await log('error', `Invalid config. ${String(error)}`, {error});
            process.exit(1);
        }

        const queue = new MailQueue();

        if(Config.webEnabled)
        {
            try {
                await new WebServer(queue).listen();
            } catch(error) {
                log('error', `Failed to start web interface. ${String(error)}`, {error});
                process.exit(1);
            }
        }

        const server = new SMTPServer(queue);
        try {
            await server.listen();
        } catch(error) {
            log('error', `Failed to start SMTP server. ${String(error)}`, {error});
            process.exit(1);
        }
    })();
}

// Exit with code 0 on Ctrl+C
process.on('SIGINT', ()=>{
    Archive.close();
    process.exit(0);
});

// Exit with code 0 when container is stopped
process.on('SIGTERM', ()=>{
    Archive.close();
    process.exit(0);
});
