import fs from 'fs';
import readline from 'readline';
import { Mutex, Semaphore } from 'async-mutex';
import axios, { AxiosRequestConfig, AxiosResponse, isAxiosError } from 'axios';
import { Base64Encode } from 'base64-stream';
import addressparser from 'nodemailer/lib/addressparser';
import { ConfidentialClientApplication } from '@azure/msal-node';
import { Config } from './Config';
import { UnrecoverableError } from './Constants';
import { MsalProxy } from './MsalProxy';
import { Readable } from 'stream';
import { rewriteSender } from './MailRewrite';

export class MailboxAccessDenied extends UnrecoverableError { }
export class InvalidMailContent extends UnrecoverableError { }
export class MessageSizeExceeded extends UnrecoverableError { }
export class MailboxNotFound extends UnrecoverableError { }

/** Graph error codes meaning the user doesn't exist or has no (Exchange Online) mailbox */
const MAILBOX_NOT_FOUND_CODES = ['ErrorInvalidUser', 'MailboxNotEnabledForRESTAPI', 'MailboxNotHostedInExchangeOnline', 'ResourceNotFound', 'Request_ResourceNotFound'];

export interface ISendResult
{
    /** Mailbox the mail was sent from */
    mailbox: string;
    /** Set when the fallback mailbox was used: the original (non-existing) sending mailbox */
    fallbackFor?: string;
}

export class Mailer
{
    /** Prevent getting an accesstoken in parallel */
    static #aquireTokenMutex = new Mutex();
    /** Prevent sending more than 4 messages in parallel (see: https://learn.microsoft.com/en-us/graph/throttling-limits#outlook-service-limits) */
    static #sendSemaphore = new Semaphore(4);

    static #msalClient = (Config.clientId && (Config.clientSecret || (Config.clientCertificateThumbprint && Config.clientCertificateKeyPath)))?new ConfidentialClientApplication({
        auth: {
            authority: Config.msalAuthority,
            clientId: Config.clientId,
            clientSecret: Config.clientSecret,
            clientCertificate: Config.clientCertificateThumbprint && Config.clientCertificateKeyPath?{
                thumbprint: Config.clientCertificateThumbprint,
                privateKey: Config.clientCertificateKey!,
            }:undefined,
        },
        system: Config.httpProxyConfig?{networkClient: new MsalProxy()}:undefined, // We use our custom implementation, because the `proxyUrl` property doesn't want to work
    }):undefined;

    static async sendEml(filePath: string): Promise<ISendResult>
    {
        return this.#sendSemaphore.runExclusive(async ()=>{
            // Determine the sender
            let sender = Config.forceMailbox;
            if(!sender) // There's no forced sender in the config, so we get it from the mail data
            {
                const senderObj = await this.#findSender(filePath);
                if(!senderObj) throw new UnrecoverableError('No sender/from address defined');
                sender = senderObj.address;
            }

            // Fetch an accesstoken if needed
            const token = await this.#aquireToken();

            // Send the message
            try {
                await this.#post(filePath, sender, token, ()=>fs.createReadStream(filePath));
                return {mailbox: sender} as ISendResult;
            } catch(error) {
                const fallback = Config.fallbackMailbox;
                if(!(error instanceof MailboxNotFound) || !fallback || fallback.toLowerCase() === sender.toLowerCase())
                    throw error;

                // The sending mailbox doesn't exist: send from the fallback mailbox with a rewritten From header
                await this.#post(filePath, fallback, token, ()=>rewriteSender(filePath, fallback));
                return {mailbox: fallback, fallbackFor: sender} as ISendResult;
            }
        });
    }

    /**
     * Send MIME content from a mailbox and translate Graph errors
     * @param createContent Creates a new stream of the MIME content, called for every attempt (a stream can only be read once)
     */
    static async #post(filePath: string, mailbox: string, token: string, createContent: ()=>Readable)
    {
        try {
            await this.#retryableRequest(createContent, {
                method: 'post',
                url: `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/sendMail`,
                headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'text/plain',
                    'User-Agent': `SMPT2Graph/${VERSION}`,
                },
                proxy: Config.httpProxyConfig,
            });
        } catch(error: any) {
            if(isAxiosError(error) && error.response?.data)
            {
                const data = error.response?.data;
                if('error' in data && 'code' in data.error)
                {
                    if(error.response.status === 404 || MAILBOX_NOT_FOUND_CODES.includes(data.error.code))
                        throw new MailboxNotFound(`Mailbox "${mailbox}" does not exist or has no Exchange Online mailbox (${data.error.code})`);
                    else if(data.error.code === 'ErrorAccessDenied')
                        throw new MailboxAccessDenied(`Access to mailbox "${mailbox}" denied`);
                    else if(data.error.code === 'ErrorMimeContentInvalidBase64String')
                        throw new InvalidMailContent(`Invalid content for mail "${filePath}"`);
                    else if(data.error.code === 'ErrorMessageSizeExceeded')
                        throw new MessageSizeExceeded(`The message exceeds the maximum supported size for mail "${filePath}"`);
                    else
                        throw new Error(JSON.stringify(data.error));
                }
                else
                    throw data;
            }
            else
                throw error;
        }
    }

    /** The MSAL client of the configured app registration (undefined when not configured) */
    static get msalClient()
    {
        return this.#msalClient;
    }

    /** Get an app-only access token for the Graph API */
    static getAppToken(): Promise<string>
    {
        return this.#aquireToken();
    }

    /**
     * Automatically retry a request when it's being throttled by the Graph API
     * @param createContent Creates the (MIME) content for each attempt. It's base64 encoded and sent as request body
     */
    static async #retryableRequest<RequestData = any, ReponseData = any>(createContent: ()=>Readable, request: AxiosRequestConfig<RequestData>): Promise<AxiosResponse<RequestData, ReponseData>>
    {
        const retryLimit = 3;
        let retryCount = 0;
        let wait = 200;

        const retry = async (): Promise<AxiosResponse<RequestData, ReponseData>> =>
        {
            const abortController = new AbortController();
            const connectTimeout = setTimeout(()=>abortController.abort(`Server did not respond within 10 seconds`), 10000);
            const overallTimeout = setTimeout(()=>abortController.abort(`Failed to send message within 120 seconds`), 120000);
            const content = createContent(); // A fresh stream for every attempt, a stream that was (partly) sent can't be sent again

            try {
                return await axios({
                    ...request,
                    data: content.pipe(new Base64Encode()) as any,
                    signal: abortController.signal,
                    onUploadProgress: progress=>{
                        clearTimeout(connectTimeout);
                    },
                });
            } catch(error) {
                if(++retryCount > retryLimit) // We've reached our retry limit?
                    throw error;
                else if(isAxiosError(error) && (error.response?.status === 429 || error.response?.status === 503 || error.response?.status === 504)) // We got a retryable response?
                {
                    // Node delivers header names in lower case
                    const retryAfter = error.response.headers['retry-after'];
                    if(retryAfter && !isNaN(retryAfter)) // We got throttled
                        wait = Math.min(parseInt(retryAfter) * 1000, 60000);
                    else
                        wait *= 2;

                    await this.#sleep(wait);

                    return retry();
                }
                else if(axios.isCancel(error) && abortController.signal.aborted)
                    throw abortController.signal.reason;
                else // Unknown error response, throw the error
                    throw error;
            } finally {
                clearTimeout(connectTimeout);
                clearTimeout(overallTimeout);
                content.destroy();
            }
        };

        return retry();
    }

    static #sleep(ms: number): Promise<void>
    {
        return new Promise(r=>setTimeout(r, ms));
    }

    /** Get sender address from EML/RFC822 data */
    static async #findSender(filePath: string)
    {
        const readStream = fs.createReadStream(filePath);
        const reader = readline.createInterface({
            input: readStream,
            crlfDelay: Infinity, // To treat \r\n and \n the same
        });

        let currentHeader: string | null = null;

        const tryParseCurrentHeader = () => {
            if (currentHeader === null) return null;
            if (
                currentHeader.toLowerCase().startsWith('sender:') ||
                currentHeader.toLowerCase().startsWith('from:')
            ) {
                const parsed = addressparser(
                    currentHeader.substring(currentHeader.indexOf(':') + 1),
                    { flatten: true }
                );
                if (parsed.length && parsed[0].address) {
                    return parsed[0];
                }
            }
            return null;
        };

        for await (const line of reader)
        {
            if (line === '') // We've reached the end of the headers?
            {
                const result = tryParseCurrentHeader();
                if (result) {
                    readStream.destroy();
                    return result;
                }
                break;
            }
            else if (/^[ \t]/.test(line)) // Folded continuation line
            {
                if (currentHeader !== null) {
                    // Unfold per RFC 5322: replace the fold with a single space
                    currentHeader += ' ' + line.trim();
                }
                // If currentHeader is null, this is a stray continuation with no
                // preceding header (malformed) — safely ignore it.
            }
            else // New header line — check the previous one, then start fresh
            {
                const result = tryParseCurrentHeader();
                if (result) {
                    readStream.destroy();
                    return result;
                }
                currentHeader = line;
            }
        }

        // In case the header block ended without a trailing blank line
        const result = tryParseCurrentHeader();
        if (result) {
            readStream.destroy();
            return result;
        }

        readStream.destroy();
        return undefined;
    }

    static async #aquireToken(): Promise<string>
    {
        return this.#aquireTokenMutex.runExclusive(async ()=>{
            if(!this.#msalClient) throw new UnrecoverableError('Trying to login without an application registration');

            const res = await this.#msalClient.acquireTokenByClientCredential({
                scopes: ['https://graph.microsoft.com/.default'],
            });
            return res?.accessToken!;
        });
    }

}
