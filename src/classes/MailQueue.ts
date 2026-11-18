import fs from 'fs';
import path from 'path';
import chokidar from 'chokidar';
import { Mutex } from 'async-mutex';
import { Mailer, ISendResult } from './Mailer';
import { prefixedLog } from './Logger';
import { Config } from './Config';
import { UnrecoverableError } from './Constants';
import { Archive, IReceiveMeta } from './Archive';

const log = prefixedLog('MailQueue');

export class MailQueue
{
    /** While true, no files from the queue folder will be processed */
    #paused = false;
    #rootPath: string;
    #tempPath: string;
    #queuePath: string;
    #failedPath: string;
    #archivePath: string;
    #watcher: chokidar.FSWatcher|undefined;
    /** Remember mails to retry. Key = filename */
    #retryQueue = new Map<string, {retryAfter: Date, retryCount: number}>();
    #retryQueueInterval: NodeJS.Timeout|undefined;
    /** Prevent multiple retries from running simultaneous */
    #retryMutex = new Mutex();

    /**
     * Create a mail queue
     * @param rootPath Path where the queue, temp and failed folders are located/created
     */
    constructor(rootPath: string = 'mailroot')
    {
        this.#paused = Config.mode === 'receive';
        this.#rootPath = rootPath;
        this.#tempPath = path.join(rootPath, 'temp');
        this.#queuePath = path.join(rootPath, 'queue');
        this.#failedPath = path.join(rootPath, 'failed');
        this.#archivePath = path.join(rootPath, 'archive');
        this.#ensureFolderStructure();
        Archive.init(rootPath);
        this.#startWatcher();
    }

    get tempPath(): string
    {
        return this.#tempPath;
    }

    #startWatcher()
    {
        if(this.#paused) return; // Don't start the watcher when it's paused

        this.#watcher = chokidar.watch(path.join(this.#queuePath, '*.eml'));
        this.#watcher.on('error', (error)=>{
            log('error', `An error occured watching the queue folder`, {error});
        });
        this.#watcher.on('add', this.#onFileAdded.bind(this));
    }

    async #onFileAdded(filePath: string)
    {
        const filename = path.basename(filePath);
        log('verbose', `File "${filename}" appeared in the queue`);

        await Archive.ensureRecord(filePath);
        Archive.markAttempt(filename);

        try {
            const result = await Mailer.sendEml(filePath);
            if(result.fallbackFor)
                log('warn', `Mailbox "${result.fallbackFor}" does not exist, sent "${filename}" from fallback mailbox "${result.mailbox}"`);
            await this.#onSent(filePath, result);
            this.#removeFromRetryQueue(filename);
        } catch(error) {
            log('error', `Failed to send message "${filename}"`, {error, filename});
            const errorMsg = (error instanceof Error)?error.message:String(error);

            if(error instanceof UnrecoverableError || !Config.sendRetryLimit) // Retrying makes no sense or is disabled
                this.#moveToFailed(filename, errorMsg);
            else
                this.#addToRetryQueue(filename, errorMsg);
        }
    }

    /** Archive or delete a successfully sent mail */
    async #onSent(filePath: string, result: ISendResult)
    {
        const filename = path.basename(filePath);

        if(Archive.enabled && Config.archiveStoreContent)
        {
            try {
                await renameWithRetry(filePath, path.join(this.#archivePath, filename));
                Archive.markSent(filename, result, 'archive');
                return;
            } catch(error) {
                log('error', `Error moving "${filename}" to the archive`, {error, filename});
            }
        }

        // Never leave a sent mail in the queue, it would be sent again after a restart
        this.remove(filePath);
        Archive.markSent(filename, result, 'deleted');
    }

    #moveToFailed(filename: string, errorMsg: string)
    {
        this.#retryQueue.delete(filename);
        this.#startStopRetryQueue();

        renameWithRetry(path.join(this.#queuePath, filename), path.join(this.#failedPath, filename))
            .then(()=>'failed' as const)
            .catch(error=>{
                log('error', `Error moving file "${filename}" from queue to failed dir`, {error, filename});
                return 'queue' as const;
            })
            .then(location=>Archive.markFailed(filename, errorMsg, location));
    }

    #addToRetryQueue(filename: string, errorMsg: string)
    {
        const data = this.#retryQueue.get(filename);
        if(data && data.retryCount >= Config.sendRetryLimit) // This file is already in the queue and exceeded the retry limit?
            this.#moveToFailed(filename, errorMsg);
        else // This file should be retried
        {
            const retryAfter = new Date();
            retryAfter.setMinutes(retryAfter.getMinutes()+Config.sendRetryInterval);
            this.#retryQueue.set(filename, {retryAfter, retryCount: (data?.retryCount || 0)+1});
            Archive.markRetrying(filename, errorMsg);

            // Start the queue if necessary
            this.#startStopRetryQueue();
        }
    }

    #removeFromRetryQueue(filename: string)
    {
        if(this.#retryQueue.has(filename)) // Was this file in the retry queue?
        {
            this.#retryQueue.delete(filename);
            this.#startStopRetryQueue(); // Stop the queue if it's empty
        }
    }

    /** Start the retry queue if it's not already started and it's not empty */
    #startStopRetryQueue()
    {
        if(!this.#retryQueueInterval && this.#retryQueue.size > 0) // The queue is not started, but there are items waiting?
            this.#retryQueueInterval = setInterval(this.#retry.bind(this), 30000); // Fire retry every 30 seconds
        else if(this.#retryQueueInterval && this.#retryQueue.size === 0) // The queue is started, but it's empty?
        {
            clearInterval(this.#retryQueueInterval);
            this.#retryQueueInterval = undefined;
        }
    }

    async #retry()
    {
        if(this.#retryQueue.size === 0) return;
        if(this.#retryMutex.isLocked()) return; // Skip if it's already retrying

        await this.#retryMutex.runExclusive(async ()=>{
            for(const [filename,data] of this.#retryQueue)
            {
                if(data.retryAfter.getTime() < Date.now()) // This item should be retried?
                    await this.#onFileAdded(path.join(this.#queuePath, filename));
            }
        });
    }

    /**
     * Move a received mail from the temp folder into the queue
     * @param meta Information about the SMTP session, stored in the archive
     */
    add(filePath: string, meta?: IReceiveMeta)
    {
        // Record the mail before it becomes visible in the queue, so the sender finds the metadata
        Archive.recordReceived(filePath, meta)
            .catch(error=>log('error', `Failed to archive metadata of "${path.basename(filePath)}"`, {error}))
            .finally(()=>this.#moveToQueue(filePath));
    }

    #moveToQueue(filePath: string)
    {
        const filename = path.basename(filePath);
        const dest = path.join(this.#queuePath, filename);

        const attempt = (tries = 0) => {
            try {
                fs.renameSync(filePath, dest);
                log('verbose', `Moved file "${filename}" to queue`);
            } catch(error: any) {
                // On Windows the file may still be locked for a brief moment after
                // the stream closes.  Instead of failing permanently we retry a few
                // times with a small backoff.
                if(error.code === 'EPERM' && process.platform === 'win32' && tries < 5) {
                    log('warn', `EPERM renaming "${filename}", retrying`, {tries});
                    setTimeout(() => attempt(tries + 1), 100);
                } else {
                    log('error', `Error while moving "${filename}" to queue`, {error, filename});
                }
            }
        };

        attempt();
    }

    /**
     * Put a failed mail back in the queue
     * @returns An error message, or undefined on success
     */
    resend(filename: string, requestedBy?: string): string|undefined
    {
        filename = path.basename(filename); // Prevent path traversal
        const record = Archive.get(filename);
        if(!record) return 'Mail not found';
        if(record.status !== 'failed') return `Only failed mails can be resent (current status: ${record.status})`;

        const source = Archive.filePath(record);
        if(!source) return 'The mail file no longer exists';

        if(record.location !== 'queue')
        {
            try {
                fs.renameSync(source, path.join(this.#queuePath, filename));
            } catch(error) {
                log('error', `Failed to move "${filename}" back to the queue`, {error, filename});
                return `Failed to move the mail back to the queue: ${String(error)}`;
            }
        }

        this.#retryQueue.delete(filename);
        Archive.markResent(filename, requestedBy);
        log('info', `Mail "${filename}" was put back in the queue${requestedBy?` by ${requestedBy}`:''}`);

        // A file that never left the queue doesn't trigger the watcher, process it directly
        if(record.location === 'queue' && !this.#paused)
            this.#onFileAdded(path.join(this.#queuePath, filename));
    }

    remove(filePath: string)
    {
        try {
            fs.unlinkSync(filePath);
        } catch(error) {
            log('error', `Error while deleting "${filePath}" from queue`, {error});
        }
    }

    #ensureFolderStructure()
    {
        for(const dir of [this.#rootPath, this.#tempPath, this.#queuePath, this.#failedPath])
        {
            if(!this.#pathExists(dir)?.isDirectory())
                fs.mkdirSync(dir);
        }
    }

    #pathExists(path: string)
    {
        try {
            return fs.statSync(path);
        } catch(error: any) {
            if(!('code' in error) || error.code !== 'ENOENT')
                throw error;
        }
    }
}

/** Rename a file. On Windows a file can be locked for a brief moment after its stream was closed, so retry a few times */
async function renameWithRetry(from: string, to: string, tries = 5): Promise<void>
{
    for(let i=1; ; i++)
    {
        try {
            fs.renameSync(from, to);
            return;
        } catch(error: any) {
            if(i >= tries || !['EPERM','EBUSY','EACCES'].includes(error?.code)) throw error;
            await new Promise(resolve=>setTimeout(resolve, 100*i));
        }
    }
}
