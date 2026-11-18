import axios, { isAxiosError } from 'axios';
import { Config } from './Config';
import { Mailer } from './Mailer';
import { Archive } from './Archive';
import { prefixedLog } from './Logger';

const log = prefixedLog('Notifier');

export interface INotifyResult
{
    recipient: string;
    ok: boolean;
    error?: string;
}

interface IPendingFailure
{
    id: string;
    subject?: string|null;
    from?: string|null;
    error: string;
}

/**
 * Sends Teams activity feed notifications (Graph `sendActivityNotification`) when mails fail.
 * Notifications are throttled: failures within `throttleMinutes` are bundled into one notification.
 */
export class Notifier
{
    static #lastSent = 0;
    static #pending: IPendingFailure[] = [];
    static #timer: NodeJS.Timeout|undefined;

    static get enabled()
    {
        return Boolean(Config.notifyTeams);
    }

    /** Report a mail that failed permanently */
    static mailFailed(id: string, error: string)
    {
        if(!this.enabled) return;

        const record = Archive.get(id);
        this.#pending.push({id, error, subject: record?.subject, from: record?.envelopeFrom ?? record?.headerFrom});
        this.#schedule();
    }

    static #schedule()
    {
        if(this.#timer) return; // Already scheduled

        const throttleMs = Config.notifyTeams!.throttleMinutes*60*1000;
        const wait = Math.max(0, this.#lastSent + throttleMs - Date.now());
        // Wait a few seconds anyway, so multiple failures that happen at once end up in one notification
        this.#timer = setTimeout(()=>{
            this.#timer = undefined;
            this.#flush().catch(error=>log('error', 'Failed to send notification', {error}));
        }, Math.max(wait, 5000));
        this.#timer.unref();
    }

    static async #flush()
    {
        const items = this.#pending.splice(0);
        if(!items.length) return;
        this.#lastSent = Date.now();

        let text: string;
        let preview: string;
        if(items.length === 1)
        {
            const item = items[0];
            text = `SMTP2Graph: Versand fehlgeschlagen${item.subject?` – "${item.subject}"`:''}`;
            preview = `${item.from?`Von ${item.from}: `:''}${item.error}`;
        }
        else
        {
            text = `SMTP2Graph: ${items.length} Mails konnten nicht versendet werden`;
            const errors = [...new Set(items.map(i=>i.error))];
            preview = `Fehler: ${errors.slice(0, 3).join(' | ')}${errors.length>3?' …':''}`;
        }

        const results = await this.send(text, preview);
        for(const item of items)
        {
            const ok = results.filter(r=>r.ok).map(r=>r.recipient);
            if(ok.length) Archive.addEvent(item.id, 'notified', `Teams notification sent to ${ok.join(', ')}`);
        }
    }

    /** Send a test notification immediately (ignores throttling) */
    static sendTest(requestedBy?: string)
    {
        return this.send(
            'SMTP2Graph: Testbenachrichtigung',
            `Testbenachrichtigung${requestedBy?` ausgelöst von ${requestedBy}`:''} – Benachrichtigungen funktionieren.`,
        );
    }

    /** Send an activity notification to all configured recipients */
    static async send(text: string, preview: string): Promise<INotifyResult[]>
    {
        const cfg = Config.notifyTeams;
        if(!cfg) return [];

        let token: string;
        try {
            token = await Mailer.getAppToken();
        } catch(error) {
            const msg = `Failed to get access token: ${String((error as any)?.message ?? error)}`;
            log('error', msg, {error});
            return cfg.recipients.map(recipient=>({recipient, ok: false, error: msg}));
        }

        const webUrl = this.#deepLink();
        const results: INotifyResult[] = [];

        for(const recipient of cfg.recipients)
        {
            try {
                await axios.post(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(recipient)}/teamwork/sendActivityNotification`, {
                    topic: {
                        source: 'text',
                        value: 'SMTP2Graph',
                        webUrl,
                    },
                    activityType: 'systemDefault',
                    previewText: {content: preview.substring(0, 150)},
                    templateParameters: [{name: 'systemDefault', value: text}],
                }, {
                    headers: {
                        Authorization: `Bearer ${token}`,
                        'User-Agent': `SMPT2Graph/${VERSION}`,
                    },
                    proxy: Config.httpProxyConfig,
                    timeout: 20000,
                });
                results.push({recipient, ok: true});
            } catch(error) {
                let msg = String((error as any)?.message ?? error);
                if(isAxiosError(error) && error.response?.data?.error)
                    msg = `${error.response.data.error.code}: ${error.response.data.error.message}`;
                log('error', `Failed to notify "${recipient}": ${msg}`, {error: msg});
                results.push({recipient, ok: false, error: msg});
            }
        }

        log('info', `Teams notification sent to ${results.filter(r=>r.ok).length}/${results.length} recipient(s)`);
        return results;
    }

    /** The notification must link into Teams. We link to the personal tab of our Teams app */
    static #deepLink()
    {
        const appId = Config.notifyTeams?.teamsAppId;
        if(appId)
            return `https://teams.microsoft.com/l/entity/${encodeURIComponent(appId)}/smtp2graph`;
        else
            return 'https://teams.microsoft.com/';
    }
}
