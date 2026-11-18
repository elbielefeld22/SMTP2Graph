import fs from 'fs';
import { parseDocument } from 'yaml';
import { Config } from './Config';
import { Archive } from './Archive';
import { prefixedLog } from './Logger';

const log = prefixedLog('Settings');

type SettingType = 'int'|'bool'|'email'|'text'|'size';

export interface ISettingDefinition
{
    /** Dotted path in config.yml */
    key: string;
    group: string;
    label: string;
    help?: string;
    type: SettingType;
    /** An empty value removes the setting from config.yml (the default applies) */
    optional?: boolean;
    min?: number;
    max?: number;
    maxLength?: number;
    unit?: string;
    /** Shown as placeholder / used when the setting is not in config.yml */
    defaultValue: string|number|boolean;
    /** Current effective value */
    get: ()=>string|number|boolean;
    /** Only show the setting when this returns true */
    visible?: ()=>boolean;
}

/**
 * Settings that can be changed in the web interface.
 * Only settings that apply without restart and can't make the service unstartable or lock users out of the web interface:
 * no ports, addresses, TLS, IP/FROM whitelists, SMTP users, app registration, login/group settings or the proxy.
 */
export const SETTINGS: ISettingDefinition[] = [
    {key: 'send.retryLimit', group: 'Versand', label: 'Wiederholungen bei Fehlern', type: 'int', min: 0, max: 50, defaultValue: 3,
        help: 'Weitere Versuche bei vorübergehenden Fehlern (Drosselung, Verbindungsabbruch). 0 = Mail sofort als fehlgeschlagen markieren.',
        get: ()=>Config.sendRetryLimit},
    {key: 'send.retryInterval', group: 'Versand', label: 'Abstand zwischen Wiederholungen', type: 'int', min: 1, max: 1440, unit: 'Minuten', defaultValue: 5,
        get: ()=>Config.sendRetryInterval},
    {key: 'send.forceMailbox', group: 'Versand', label: 'Immer über dieses Postfach senden', type: 'email', optional: true, defaultValue: '',
        help: 'Leer = über das Postfach des Absenders. Das Postfach braucht „Senden als“ bzw. „Senden im Auftrag von“ für alle Absender.',
        get: ()=>Config.forceMailbox ?? ''},
    {key: 'send.fallbackMailbox', group: 'Versand', label: 'Ersatzpostfach', type: 'email', optional: true, defaultValue: '',
        help: 'Wird genutzt, wenn das Postfach des Absenders nicht existiert. Der Absender (From) wird dabei durch dieses Postfach ersetzt. Leer = keine Ersatzzustellung.',
        get: ()=>Config.fallbackMailbox ?? ''},
    {key: 'receive.banner', group: 'Empfang (SMTP)', label: 'Begrüßungstext (Banner)', type: 'text', optional: true, maxLength: 100, defaultValue: `SMTP2Graph ${VERSION}`,
        help: 'Text, den SMTP-Clients beim Verbinden sehen.',
        get: ()=>Config.smtpBanner ?? ''},
    {key: 'receive.maxSize', group: 'Empfang (SMTP)', label: 'Maximale Mailgröße', type: 'size', defaultValue: '100m',
        help: 'Zahl mit k (Kilobyte) oder m (Megabyte), z. B. 25m. Größere Mails werden beim Empfang abgelehnt.',
        get: ()=>Config.smtpMaxSizeSetting},
    {key: 'archive.retentionDays', group: 'Archiv', label: 'Aufbewahrungsdauer', type: 'int', min: 1, max: 3650, unit: 'Tage', defaultValue: 30,
        help: 'Ältere Mails und Metadaten werden stündlich gelöscht. Verkürzen löscht ältere Mails beim nächsten Aufräumen endgültig.',
        get: ()=>Config.archiveRetentionDays},
    {key: 'archive.storeContent', group: 'Archiv', label: 'Inhalt gesendeter Mails speichern', type: 'bool', defaultValue: true,
        help: 'Aus = von erfolgreich gesendeten Mails werden nur Metadaten behalten. Fehlgeschlagene Mails werden immer gespeichert (für erneutes Senden).',
        get: ()=>Config.archiveStoreContent},
    {key: 'web.auth.sessionHours', group: 'Weboberfläche', label: 'Sitzungsdauer', type: 'int', min: 1, max: 168, unit: 'Stunden', defaultValue: 8,
        help: 'Danach ist eine neue Anmeldung nötig (per SSO meist ohne Eingabe). Gilt für neue Anmeldungen.',
        get: ()=>Config.webSessionHours, visible: ()=>Config.webAuthEnabled},
];

export class SettingsError extends Error
{
    constructor(message: string, public fieldErrors: Record<string, string> = {})
    {
        super(message);
    }
}

export class Settings
{
    static list()
    {
        return SETTINGS.filter(s=>!s.visible || s.visible()).map(s=>({
            key: s.key, group: s.group, label: s.label, help: s.help, type: s.type, optional: Boolean(s.optional),
            min: s.min, max: s.max, maxLength: s.maxLength, unit: s.unit, defaultValue: s.defaultValue, value: s.get(),
        }));
    }

    /** Normalize and check a value. Returns the value to write, null to remove the setting, or throws a message */
    static #normalize(def: ISettingDefinition, raw: unknown): string|number|boolean|null
    {
        if(def.optional && (raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '')))
            return null;

        switch(def.type)
        {
            case 'int': {
                const n = typeof raw === 'number'?raw:Number(String(raw).trim());
                if(!Number.isInteger(n)) throw 'Bitte eine ganze Zahl eingeben';
                if(def.min !== undefined && n < def.min) throw `Mindestens ${def.min}`;
                if(def.max !== undefined && n > def.max) throw `Höchstens ${def.max}`;
                return n;
            }
            case 'bool':
                if(typeof raw !== 'boolean') throw 'Ungültiger Wert';
                return raw;
            case 'email': {
                const v = String(raw).trim();
                if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) throw 'Bitte eine gültige E-Mail-Adresse eingeben';
                return v;
            }
            case 'text': {
                const v = String(raw).trim();
                if(/[\r\n]/.test(v) || /[^\x20-\x7e -￿]/.test(v)) throw 'Ungültige Zeichen';
                if(def.maxLength && v.length > def.maxLength) throw `Höchstens ${def.maxLength} Zeichen`;
                return v;
            }
            case 'size': {
                const v = String(raw).trim().toLowerCase();
                const m = /^(\d+)(k|m)$/.exec(v);
                if(!m) throw 'Format: Zahl mit k oder m, z. B. 25m';
                const bytes = Number(m[1]) * (m[2] === 'k'?1024:1024*1024);
                if(bytes < 10*1024) throw 'Mindestens 10k';
                if(bytes > 150*1024*1024) throw 'Höchstens 150m';
                return v;
            }
        }
    }

    /**
     * Change settings: validates the values and the resulting config, writes config.yml (comments are kept,
     * a backup is written to config.yml.bak) and activates it without restart.
     * @returns The changed settings
     */
    static update(changes: Record<string, unknown>, user: string)
    {
        if(!changes || typeof changes !== 'object' || Array.isArray(changes)) throw new SettingsError('Ungültige Anfrage');

        // Check the values
        const fieldErrors: Record<string, string> = {};
        const updates: {def: ISettingDefinition, value: string|number|boolean|null, old: string|number|boolean}[] = [];
        for(const [key, raw] of Object.entries(changes))
        {
            const def = SETTINGS.find(s=>s.key === key && (!s.visible || s.visible()));
            if(!def)
            {
                fieldErrors[key] = 'Diese Einstellung kann nicht über die Weboberfläche geändert werden';
                continue;
            }
            try {
                const value = this.#normalize(def, raw);
                const old = def.get();
                if(value !== (def.optional && old === ''?null:old)) updates.push({def, value, old});
            } catch(error) {
                fieldErrors[key] = String(error);
            }
        }
        if(Object.keys(fieldErrors).length) throw new SettingsError('Ungültige Eingaben', fieldErrors);
        if(!updates.length) return [];

        // Apply to the YAML document (keeps comments and formatting)
        const file = Config.configFile;
        const original = fs.readFileSync(file).toString('utf-8');
        const doc = parseDocument(original);
        if(doc.errors.length) throw new SettingsError(`config.yml kann nicht gelesen werden: ${doc.errors[0].message}`);

        for(const u of updates)
        {
            const path = u.def.key.split('.');
            if(u.value === null)
                doc.deleteIn(path);
            else
                doc.setIn(path, u.value);
        }

        // Make sure the result is a valid config before writing it
        const error = Config.validateCandidate(doc.toJS());
        if(error) throw new SettingsError(`Die Änderung würde eine ungültige Konfiguration ergeben: ${error}`);

        let text = doc.toString();
        if(original.includes('\r\n')) text = text.replace(/\r?\n/g, '\r\n');

        // Write atomically (temp file + rename), keep a backup
        const tmp = `${file}.tmp`;
        try {
            fs.writeFileSync(tmp, text);
            fs.copyFileSync(file, `${file}.bak`);
            fs.renameSync(tmp, file);
        } catch(err) {
            try { fs.unlinkSync(tmp); } catch { /* ignore */ }
            throw new SettingsError(`config.yml konnte nicht geschrieben werden: ${String(err)}`);
        }

        const reloadError = Config.reload();
        if(reloadError) // Should not happen, we validated before. Restore the previous file to be safe
        {
            fs.writeFileSync(file, original);
            Config.reload();
            throw new SettingsError(`Die Änderung wurde zurückgenommen: ${reloadError}`);
        }

        const result = updates.map(u=>({key: u.def.key, label: u.def.label, old: u.old,
            new: u.value ?? (u.def.defaultValue !== ''?`${u.def.defaultValue} (Standard)`:'')}));
        for(const r of result)
        {
            log('info', `User "${user}" changed "${r.key}" from "${r.old}" to "${r.new}"`);
            Archive.logSetting(user, r.key, String(r.old), String(r.new));
        }
        return result;
    }
}
