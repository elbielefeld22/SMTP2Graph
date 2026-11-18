import fs from 'fs';
import { parse as parseYaml } from 'yaml';
import IPCIDR from 'ip-cidr';
import { AxiosProxyConfig } from 'axios';

// Set the working dir based on the --baseDir argument
const baseDir = process.argv.find(arg=>arg.startsWith('--baseDir=') && arg.length > 10)?.substring(10);
if(baseDir) process.chdir(baseDir);

export interface IConfig
{
    mode: 'full'|'receive'|'send';
    send?: {
        appReg: {
            /** The tenant name (the part that comes before .onmicrosoft.com) */
            tenant: string,
            /** Entra ID App. registration client ID */
            id: string,
            /** Entra ID App. registration secret */
            secret?: string,
            /** Enrta ID App. registrations client certificate */
            certificate?: {
                thumbprint: string,
                privateKeyPath: string;
            },
        },
        /** Times to retry sending a message when it failed (0 = do not retry) */
        retryLimit?: number;
        /** Minutes between tries */
        retryInterval?: number;
        /** Always send from this mailbox */
        forceMailbox?: string;
        /** Send from this mailbox (with a rewritten From header) when the sending mailbox doesn't exist */
        fallbackMailbox?: string;
    },
    receive?: {
        /** The port on which the SMTP server will listen (default: 25) */
        port?: number;
        /** Listen for connection on a specific IP */
        listenAddress?: string;
        /** Require a secure (TLS) connection */
        secure?: boolean;
        /** Path to the TLS key file */
        tlsKeyPath?: string;
        /** Path to the TLS certificate file */
        tlsCertPath?: string;
        /** Maximum allowed mail size. Accepts string ending with 'k' (Kilobytes) or 'm' (Megabytes) */
        maxSize?: string;
        /** The banner being shown when a client connects to the STMP server */
        banner?: string;
        /** IP addresses that are allowed to connect. This can contain single addresses or subnets in CIDR format (eg. 192.168.1.0/24) */
        ipWhitelist?: string[];
        /** Only accept those addresses as FROM addresses */
        allowedFrom?: string[];
        /** Allows authentication even if connection is not secured first, when tlsKeyPath and tlsCertPath are set */
        allowInsecureAuth?: boolean;
        /** Require login */
        requireAuth?: boolean;
        users?: {username: string, password: string, allowedFrom?: string[]}[];
        rateLimit?: {
            duration?: number,
            limit?: number;
        };
        authLimit?: {
            duration?: number,
            limit?: number;
        };
    },
    /** Keep received mails and their metadata */
    archive?: {
        /** Days to keep mails (default: 30) */
        retentionDays?: number;
        /** Keep the full EML of successfully sent mails (default: true). When false only metadata is kept */
        storeContent?: boolean;
    },
    /** Web interface */
    web?: {
        /** Port (default: 8080) */
        port?: number;
        /** Listen on a specific IP (default: all addresses) */
        listenAddress?: string;
        /** URL users use to open the web interface, e.g. https://smtp2graph.contoso.com:8080 (needed for the login redirect) */
        publicUrl?: string;
        tlsKeyPath?: string;
        tlsCertPath?: string;
        auth?: {
            /** Require an Entra ID login (default: true) */
            enabled?: boolean;
            /** Object IDs of the Entra ID / AD groups that may use the web interface */
            allowedGroups?: string[];
            /** Session lifetime in hours (default: 8) */
            sessionHours?: number;
        };
    },
    httpProxy?: {
        host: string,
        port: number,
        protocol?: 'http'|'https',
        username?: string,
        password?: string,
    }
}

export class InvalidConfig extends Error { }

export class Config
{
    static #configData: IConfig | undefined;
    static #changeListeners: (()=>void)[] = [];

    /** Path of the config file (--config=… or config.yml in the working directory) */
    static get configFile(): string
    {
        const configFileArgs = process.argv.find(arg=>arg.startsWith('--config=') && arg.length > 9);
        return configFileArgs?configFileArgs.substring(9):'config.yml';
    }

    /**
     * Check a config object without activating it
     * @returns The validation error, or undefined when it's valid
     */
    static validateCandidate(data: IConfig): string|undefined
    {
        if(!data || typeof data !== 'object') return 'The config is empty or not a YAML object';
        const previous = this.#configData;
        this.#configData = data;
        try {
            this.validate();
            return undefined;
        } catch(error) {
            return (error instanceof Error)?error.message:String(error);
        } finally {
            this.#configData = previous;
        }
    }

    /**
     * Re-read the config file. When the file is invalid the current config stays active.
     * Most settings are read on use and apply immediately; ports, addresses, TLS and the app registration need a restart.
     * @returns An error message, or undefined on success
     */
    static reload(): string|undefined
    {
        let data: IConfig;
        try {
            data = parseYaml(fs.readFileSync(this.configFile).toString('utf-8'));
        } catch(error) {
            return `Unable to read config file "${this.configFile}". ${String(error)}`;
        }

        const error = this.validateCandidate(data);
        if(error) return error;

        this.#configData = data;
        for(const listener of this.#changeListeners)
        {
            try { listener(); } catch { /* a listener must not break the reload */ }
        }
    }

    /** Get notified after the config was reloaded */
    static onChange(listener: ()=>void)
    {
        this.#changeListeners.push(listener);
    }

    /** Check if the config file is valid */
    static validate()
    {
        const isStringValue = (val: any)=>{
            return (typeof val === 'string' && val);
        };

        if(typeof this.mode !== 'string' || !['full','receive','send'].includes(this.mode))
            throw new InvalidConfig('Invalid "mode" config property');

        if(this.mode !== 'receive') // We're also sending?
        {
            if(!isStringValue(this.clientId))
                throw new InvalidConfig('Missing "appReg.id" property');
            else if(!isStringValue(this.clientSecret) && !isStringValue(this.clientCertificateKeyPath) && !isStringValue(this.clientCertificateThumbprint))
                throw new InvalidConfig('Missing "appReg.secret" or "appReg.certificate" property');
            else if(this.clientCertificateKeyPath && !fs.existsSync(this.clientCertificateKeyPath))
                throw new InvalidConfig(`Client key file "${this.clientCertificateKeyPath}" could not be found`);
            else if(!isStringValue(this.clientTenant))
                throw new InvalidConfig('Missing "appReg.tenant" property');
        }
        
        if(this.fallbackMailbox !== undefined && (typeof this.fallbackMailbox !== 'string' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(this.fallbackMailbox)))
            throw new InvalidConfig('"send.fallbackMailbox" should be an email address');
        else if(this.sendRetryInterval !== undefined && this.sendRetryInterval < 1)
            throw new InvalidConfig('"retryInterval" may not be smaller than 1');
        else if(this.smtpRequireAuth && !this.smtpUsers?.length)
            throw new InvalidConfig('"requireAuth" enabled without users defined');
        else if(this.#config.receive?.maxSize && (typeof this.#config.receive.maxSize !== 'string' || !/^\d+k|m$/i.test(this.#config.receive.maxSize)))
            throw new InvalidConfig('"maxSize" property is invalid');
        else if(this.smtpListenIp && !IPCIDR.isValidAddress(this.smtpListenIp))
            throw new InvalidConfig('"listenAddress" property is invalid');
        else if(this.smtpTlsKeyPath && !fs.existsSync(this.smtpTlsKeyPath))
            throw new InvalidConfig(`Key file "${this.smtpTlsKeyPath}" could not be found`);
        else if(this.smtpTlsCertPath && !fs.existsSync(this.smtpTlsCertPath))
            throw new InvalidConfig(`Cert file "${this.smtpTlsCertPath}" could not be found`);
        else if(this.smtpTlsKeyPath && !this.smtpTlsCertPath)
            throw new InvalidConfig(`Property "tlsKeyPath" is defined without "tlsCertPath"`);
        else if(!this.smtpTlsKeyPath && this.smtpTlsCertPath)
            throw new InvalidConfig(`Property "smtpTlsCertPath" is defined without "tlsKeyPath"`);
        else if(this.smtpRateLimitDuration && typeof this.smtpRateLimitDuration !== 'number')
            throw new InvalidConfig(`Property "receive.rateLimit.duration" should be a number`);
        else if(this.smtpRateLimitLimit && typeof this.smtpRateLimitLimit !== 'number')
            throw new InvalidConfig(`Property "receive.rateLimit.limit" should be a number`);
        else if(this.smtpAuthLimitDuration && typeof this.smtpAuthLimitDuration !== 'number')
            throw new InvalidConfig(`Property "receive.authLimit.duration" should be a number`);
        else if(this.smtpAuthLimitDuration && typeof this.smtpAuthLimitDuration !== 'number')
            throw new InvalidConfig(`Property "receive.authLimit.limit" should be a number`);
        else if(this.#config.archive?.retentionDays !== undefined && (typeof this.#config.archive.retentionDays !== 'number' || this.#config.archive.retentionDays < 1))
            throw new InvalidConfig(`Property "archive.retentionDays" should be a number >= 1`);
        else if(this.webEnabled && !this.archiveEnabled)
            throw new InvalidConfig(`The web interface ("web") requires the archive ("archive") to be enabled`);
        else if(this.webEnabled && this.webListenIp && !IPCIDR.isValidAddress(this.webListenIp))
            throw new InvalidConfig('"web.listenAddress" property is invalid');
        else if(this.webEnabled && Boolean(this.webTlsKeyPath) !== Boolean(this.webTlsCertPath))
            throw new InvalidConfig(`Properties "web.tlsKeyPath" and "web.tlsCertPath" should be defined together`);
        else if(this.webTlsKeyPath && !fs.existsSync(this.webTlsKeyPath))
            throw new InvalidConfig(`Key file "${this.webTlsKeyPath}" could not be found`);
        else if(this.webTlsCertPath && !fs.existsSync(this.webTlsCertPath))
            throw new InvalidConfig(`Cert file "${this.webTlsCertPath}" could not be found`);
        else if(this.webEnabled && this.webAuthEnabled && !this.hasAppReg)
            throw new InvalidConfig(`The web login requires "send.appReg" to be configured`);
        else if(this.webEnabled && this.webAuthEnabled && !this.webAllowedGroups.length)
            throw new InvalidConfig(`Property "web.auth.allowedGroups" should contain at least one group object ID`);
        else if(this.webEnabled && this.webAuthEnabled && !this.webPublicUrl)
            throw new InvalidConfig(`Property "web.publicUrl" is required when the web login is enabled`);
        else if(this.webPublicUrl && !/^https?:\/\/[^/]+/i.test(this.webPublicUrl))
            throw new InvalidConfig(`Property "web.publicUrl" should be an absolute http(s) URL`);
        else if(this.#config.httpProxy && typeof this.#config.httpProxy.host !== 'string')
            throw new InvalidConfig(`Property "httpProxy.host" should be a string`);
        else if(this.#config.httpProxy && typeof this.#config.httpProxy.port !== 'number')
            throw new InvalidConfig(`Property "httpProxy.port" should be a number`);
        else if(this.#config.httpProxy?.protocol && !['http','https'].includes(this.#config.httpProxy.protocol))
            throw new InvalidConfig(`Property "httpProxy.protocol" should be a http or https`);
        else if(this.#config.httpProxy?.username && !this.#config.httpProxy.password)
            throw new InvalidConfig(`Property "httpProxy.username" is defined without "httpProxy.password"`);
        else if(this.#config.httpProxy?.password && !this.#config.httpProxy.username)
            throw new InvalidConfig(`Property "httpProxy.password" is defined without "httpProxy.username"`);
    }

    static get mode()
    {
        return this.#config.mode.toLowerCase() as IConfig['mode'];
    }

    static get msalAuthority()
    {
        if(/^[0-9a-f]{8}\-[0-9a-f]{4}\-[0-9a-f]{4}\-[0-9a-f]{4}\-[0-9a-f]{12}$/i.test(this.clientTenant || '')) // We got a GUID instead of name?
            return `https://login.microsoftonline.com/${this.clientTenant}`;
        else
            return `https://login.microsoftonline.com/${this.clientTenant}.onmicrosoft.com`;
    }

    static get clientTenant()
    {
        return this.#config.send?.appReg.tenant;
    }

    static get clientId()
    {
        return this.#config.send?.appReg.id;
    }

    static get clientSecret()
    {
        return this.#config.send?.appReg.secret;
    }

    static get clientCertificateThumbprint()
    {
        return this.#config.send?.appReg.certificate?.thumbprint;
    }

    static get clientCertificateKeyPath()
    {
        return this.#config.send?.appReg.certificate?.privateKeyPath;
    }

    static get clientCertificateKey()
    {
        if(this.clientCertificateKeyPath && fs.existsSync(this.clientCertificateKeyPath))
            return fs.readFileSync(this.clientCertificateKeyPath).toString();
    }

    static get sendRetryLimit()
    {
        return this.#config.send?.retryLimit ?? 3;
    }

    static get sendRetryInterval()
    {
        return this.#config.send?.retryInterval ?? 5;
    }

    static get forceMailbox()
    {
        return this.#config.send?.forceMailbox;
    }

    static get fallbackMailbox()
    {
        return this.#config.send?.fallbackMailbox;
    }

    static get smtpPort(): number
    {
        return this.#config.receive?.port ?? this.getConfigArg('receive.port', 'number') ?? 25;
    }

    static get smtpListenIp()
    {
        return this.#config.receive?.listenAddress;
    }

    static get smtpSecure()
    {
        return Boolean(this.#config.receive?.secure);
    }

    static get smtpTlsKeyPath()
    {
        return this.#config.receive?.tlsKeyPath;
    }

    static get smtpTlsKey()
    {
        if(this.smtpTlsKeyPath && fs.existsSync(this.smtpTlsKeyPath))
            return fs.readFileSync(this.smtpTlsKeyPath);
    }

    static get smtpTlsCertPath()
    {
        return this.#config.receive?.tlsCertPath;
    }

    static get smtpTlsCert()
    {
        if(this.smtpTlsCertPath && fs.existsSync(this.smtpTlsCertPath))
            return fs.readFileSync(this.smtpTlsCertPath);
    }

    static get smtpAllowTls()
    {
        return Boolean(this.smtpTlsCertPath && this.smtpTlsKeyPath && fs.existsSync(this.smtpTlsCertPath) && fs.existsSync(this.smtpTlsKeyPath));
    }

    /** Maximum message size in bytes */
    static get smtpMaxSize(): number | undefined
    {
        const matches = this.#config.receive?.maxSize?/^(\d+)(k|m)$/.exec(this.#config.receive.maxSize.toLowerCase()):undefined;

        if(matches)
        {
            if(matches[2] === 'k')
                return Number(matches[1])*1024;
            else if(matches[2] === 'm')
                return Number(matches[1])*1024*1024;
        }

        return 100*1024*1024; // Default to 100MB
    }

    /** The configured maximum size as written in the config (e.g. "25m") */
    static get smtpMaxSizeSetting(): string
    {
        return this.#config.receive?.maxSize ?? '100m';
    }

    static get smtpBanner()
    {
        return this.#config.receive?.banner;
    }

    static get smtpAllowInsecureAuth()
    {
        return this.#config.receive?.allowInsecureAuth;
    }

    static get smtpRequireAuth()
    {
        return this.#config.receive?.requireAuth;
    }

    static get smtpUsers()
    {
        return this.#config.receive?.users;
    }

    static get smtpRateLimitDuration()
    {
        return this.#config.receive?.rateLimit?.duration ?? 600;
    }

    static get smtpRateLimitLimit()
    {
        return this.#config.receive?.rateLimit?.limit ?? 10000;
    }

    static get smtpAuthLimitDuration()
    {
        return this.#config.receive?.authLimit?.duration ?? 60;
    }

    static get smtpAuthLimitLimit()
    {
        return this.#config.receive?.authLimit?.limit ?? 10;
    }

    /** True when an app registration with credentials is configured */
    static get hasAppReg()
    {
        return Boolean(this.clientId && this.clientTenant && (this.clientSecret || (this.clientCertificateThumbprint && this.clientCertificateKeyPath)));
    }

    static get archiveEnabled()
    {
        return Boolean(this.#config.archive);
    }

    static get archiveRetentionDays(): number
    {
        return this.#config.archive?.retentionDays ?? 30;
    }

    static get archiveStoreContent(): boolean
    {
        return this.#config.archive?.storeContent ?? true;
    }

    static get webEnabled()
    {
        return Boolean(this.#config.web);
    }

    static get webPort(): number
    {
        return this.#config.web?.port ?? this.getConfigArg('web.port', 'number') ?? 8080;
    }

    static get webListenIp()
    {
        return this.#config.web?.listenAddress;
    }

    static get webPublicUrl()
    {
        return this.#config.web?.publicUrl?.replace(/\/+$/, '');
    }

    static get webTlsKeyPath()
    {
        return this.#config.web?.tlsKeyPath;
    }

    static get webTlsCertPath()
    {
        return this.#config.web?.tlsCertPath;
    }

    static get webAuthEnabled(): boolean
    {
        return this.#config.web?.auth?.enabled ?? true;
    }

    static get webAllowedGroups(): string[]
    {
        return (this.#config.web?.auth?.allowedGroups ?? []).map(g=>String(g).toLowerCase());
    }

    static get webSessionHours(): number
    {
        return this.#config.web?.auth?.sessionHours ?? 8;
    }

    static get httpProxyHost()
    {
        return this.#config.httpProxy?.host;
    }

    static get httpProxyPort()
    {
        return this.#config.httpProxy?.port;
    }

    static get httpProxyProtocol(): Required<Required<IConfig>['httpProxy']>['protocol']
    {
        return this.#config.httpProxy?.protocol ?? 'http';
    }

    static get httpProxyUsername()
    {
        return this.#config.httpProxy?.username;
    }

    static get httpProxyPassword()
    {
        return this.#config.httpProxy?.username;
    }

    static get httpProxyConfig(): AxiosProxyConfig | undefined
    {
        if(this.httpProxyHost && this.httpProxyPort)
        {
            return {
                host: Config.httpProxyHost!,
                port: Config.httpProxyPort!,
                protocol: Config.httpProxyProtocol,
                auth: (Config.httpProxyUsername && Config.httpProxyPassword)?{
                    username: Config.httpProxyUsername,
                    password: Config.httpProxyPassword,
                }:undefined,
            };
        }
    }

    /** Check if an IP address is allowed to connect */
    static isIpAllowed(clientIp: string): boolean
    {
        if(!this.#config.receive?.ipWhitelist) // Setting is undefined? Then all addresses are allowed
            return true;
        else
        {
            for(const whitelisted of this.#config.receive?.ipWhitelist)
            {
                if(IPCIDR.isValidCIDR(whitelisted)) // It's a CIDR?
                {
                    const cidr = new IPCIDR(whitelisted);
                    if(cidr.contains(clientIp))
                        return true;
                }
                else if(whitelisted === clientIp)
                    return true;
            }
        }

        return false;
    }

    /** Check if a FROM address is allowed */
    static isFromAllowed(from: string, username?: string): boolean
    {
        const userAllowed = username?this.#config.receive?.users?.find(user=>user.username===username)?.allowedFrom:undefined;

        if(userAllowed) // There are user specific allowed rules?
            return userAllowed.some(allowed=>allowed.toLowerCase()===from.toLowerCase());
        if(!this.#config.receive?.allowedFrom) // Setting is undefined? Then all addresses are allowed
            return true;
        else
            return this.#config.receive.allowedFrom.some(allowed=>allowed.toLowerCase()===from.toLowerCase());
    }

    static isUserAllowed(username: string, password: string): boolean
    {
        return Boolean(this.#config.receive?.users?.some(user=>(user.username===username && user.password===password)));
    }

    static get #config(): IConfig
    {
        if(this.#configData === undefined) // We need to load the config first?
        {
            const configFile = this.configFile;

            try {
                const data = fs.readFileSync(configFile);
                try {
                    this.#configData = parseYaml(data.toString('utf-8'));
                } catch(error: any) {
                    throw `Failed to parse YAML: ${String(error)}`;
                }
            } catch(error: any) {
                throw new Error(`Unable to read config file "${configFile}". ${String(error)}`);
            }
        }

        return this.#configData!;
    }

    /** Get config value from CLI argument */
    static getConfigArg(key: string, type: 'string'): string|undefined;
    static getConfigArg(key: string, type: 'number'): number|undefined;
    static getConfigArg(key: string, type: 'number'|'string'): number|string|undefined
    {
        key = key.toLowerCase();
        const arg = process.argv.find(f=>f.toLowerCase().startsWith(`--${key}`));
        
        const value: string|undefined = arg?.split('=')[1];
        if(value === undefined) return undefined;

        if(type === 'number') // Get the number value
        {
            if(value !== '' && !isNaN(value as any))
                return Number(value);
        }
        else if(type === 'string') // Get the string value
            return value;
    }

}
