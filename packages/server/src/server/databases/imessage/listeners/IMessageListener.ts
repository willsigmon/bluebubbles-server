import fs from "fs";
import { MultiFileWatcher } from "@server/lib/MultiFileWatcher";
import type { FileChangeEvent } from "@server/lib/MultiFileWatcher";
import { Loggable } from "@server/lib/logging/Loggable";
import { Sema } from "async-sema";
import { IMessageCache, IMessagePoller } from "../pollers";
import { MessageRepository } from "..";
import { waitMs } from "@server/helpers/utils";
import { DebounceSubsequentWithWait } from "@server/lib/decorators/DebounceDecorator";
import { ScheduledService } from "@server/lib/ScheduledService";
import { Server } from "@server";

export class IMessageListener extends Loggable {
    tag = "IMessageListener";

    stopped: boolean;

    filePaths: string[];

    watcher: MultiFileWatcher;

    repo: MessageRepository;

    processLock: Sema;

    pollers: IMessagePoller[];

    cache: IMessageCache;

    lastCheck = 0;

    // FIX #750: Add fallback polling service to catch messages when file watcher fails
    fallbackPoller: ScheduledService | null = null;

    constructor({ filePaths, repo, cache }: { filePaths: string[], repo: MessageRepository, cache: IMessageCache }) {
        super();

        this.filePaths = filePaths;
        this.repo = repo;
        this.pollers = [];
        this.cache = cache;
        this.stopped = false;
        this.processLock = new Sema(1);
    }

    stop() {
        this.stopped = true;
        this.removeAllListeners();

        // FIX #750: Stop fallback poller
        if (this.fallbackPoller) {
            this.fallbackPoller.stop();
            this.fallbackPoller = null;
        }
    }

    addPoller(poller: IMessagePoller) {
        this.pollers.push(poller);
    }

    getEarliestModifiedDate() {
        let earliest = new Date();
        for (const filePath of this.filePaths) {
            const stat = fs.statSync(filePath);
            if (stat.mtime < earliest) {
                earliest = stat.mtime;
            }
        }

        return earliest;
    }

    async start() {
        this.lastCheck = this.getEarliestModifiedDate().getTime() - 60000;
        this.stopped = false;

        // Perform an initial poll to kinda seed the cache.
        // We'll use the earliest modified date of the files to determine the initial poll date.
        // We'll also subtract 1 minute just to pre-load the cache with a little bit of data.
        await this.poll(new Date(this.lastCheck), false);

        this.watcher = new MultiFileWatcher(this.filePaths);
        this.watcher.on("change", async (event: FileChangeEvent) => {
            await this.handleChangeEvent(event);
        });

        this.watcher.on("error", (error) => {
            this.log.error(`Failed to watch database files: ${this.filePaths.join(", ")}`);
            this.log.debug(`Error: ${error}`);
        });

        this.watcher.start();

        // FIX #750: Start fallback polling service using db_poll_interval setting
        // This ensures messages are caught even if file watcher fails (macOS idle, App Nap, etc.)
        const pollInterval = Server().repo.getConfig("db_poll_interval") as number ?? 5000;
        // Use minimum 3 seconds to avoid excessive polling, max 30 seconds
        const safeInterval = Math.max(3000, Math.min(pollInterval, 30000));
        this.log.debug(`Starting fallback poller with interval: ${safeInterval}ms`);

        this.fallbackPoller = new ScheduledService(async () => {
            if (this.stopped) return;

            const now = Date.now();
            const timeSinceLastCheck = now - this.lastCheck;

            // Only poll if we haven't checked recently (avoid duplicate work from file watcher)
            if (timeSinceLastCheck > safeInterval * 0.8) {
                this.log.debug(`Fallback poll triggered (${timeSinceLastCheck}ms since last check)`);
                await this.handleFallbackPoll();
            }
        }, safeInterval, true);
    }

    // FIX #750: Separate handler for fallback polling to avoid debounce conflicts
    private async handleFallbackPoll() {
        await this.processLock.acquire();
        try {
            const now = Date.now();
            let afterTime = this.lastCheck - 30000;
            if (afterTime > now || afterTime <= 0) {
                afterTime = now - 60000; // Default to 1 minute ago
            }
            await this.poll(new Date(afterTime));
            this.lastCheck = now;
            this.cache.trimCaches();
        } catch (error) {
            this.log.error(`Error in fallback poll: ${error}`);
        } finally {
            this.processLock.release();
        }
    }

    @DebounceSubsequentWithWait('IMessageListener.handleChangeEvent', 500)
    async handleChangeEvent(event: FileChangeEvent) {
        await this.processLock.acquire();
        try {
            const now = Date.now();
            let prevTime = this.lastCheck;
    
            if (prevTime <= 0 || prevTime > now) {
                this.log.debug(`Previous time is invalid (${prevTime}), setting to now...`);
                prevTime = now;
            } else if (now - prevTime > 86400000) {
                this.log.debug(`Previous time is > 24 hours ago, setting to 24 hours ago...`);
                prevTime = now - 86400000;
            }
    
            let afterTime = prevTime - 30000;
            if (afterTime > now) {
                afterTime = now;
            }
            await this.poll(new Date(afterTime));
            this.lastCheck = now;
    
            this.cache.trimCaches();
            if (this.processLock.nrWaiting() > 0) {
                await waitMs(100);
            }
        } catch (error) {
            this.log.error(`Error handling change event: ${error}`);
        } finally {
            this.processLock.release();
        }
    }

    async poll(after: Date, emitResults = true) {
        for (const poller of this.pollers) {
            const results = await poller.poll(after);

            if (emitResults) {
                for (const result of results) {
                    this.emit(result.eventType, result.data);
                    await waitMs(10);
                }
            }
        }
    }
}
