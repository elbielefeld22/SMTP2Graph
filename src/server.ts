import { Config } from './classes/Config';
import { log } from './classes/Logger';
import { MailQueue } from './classes/MailQueue';
import { SMTPServer } from './classes/SMTPServer';
import { WebServer } from './classes/WebServer';
import { Archive } from './classes/Archive';
import chokidar from 'chokidar';

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

        // Apply changes to config.yml (from the web interface or an editor) without restart
        let reloadTimer: NodeJS.Timeout|undefined;
        chokidar.watch(Config.configFile, {ignoreInitial: true}).on('all', (event)=>{
            if(event !== 'change' && event !== 'add') return;
            clearTimeout(reloadTimer);
            reloadTimer = setTimeout(()=>{
                const error = Config.reload();
                if(error) log('error', `config.yml was changed but is invalid, keeping the current settings. ${error}`, {error});
                else log('info', 'config.yml reloaded (ports, addresses, TLS and the app registration need a restart)');
            }, 500);
        });

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
