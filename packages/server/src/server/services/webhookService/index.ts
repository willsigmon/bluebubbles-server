import axios from "axios";
import { Server } from "@server";
import { Loggable } from "@server/lib/logging/Loggable";
import { Webhook } from "@server/databases/server/entity/Webhook";

export type WebhookEvent = {
    type: string;
    data: any;
};

// FIX: Cache structure for parsed webhook events
type CachedWebhook = {
    webhook: Webhook;
    eventTypes: string[];
};

/**
 * Handles dispatching webhooks
 * FIX: Added caching to avoid repeated database queries on every dispatch
 */
export class WebhookService extends Loggable {
    tag = "WebhookService";

    // FIX: Cache webhooks to avoid database query on every dispatch
    private webhookCache: CachedWebhook[] | null = null;
    private cacheExpiry = 0;
    private readonly CACHE_TTL_MS = 30000; // 30 seconds

    /**
     * Invalidate the webhook cache (call when webhooks are modified)
     */
    invalidateCache() {
        this.webhookCache = null;
        this.cacheExpiry = 0;
    }

    /**
     * Get webhooks from cache or database
     */
    private async getWebhooksWithCache(): Promise<CachedWebhook[]> {
        const now = Date.now();
        if (this.webhookCache && now < this.cacheExpiry) {
            return this.webhookCache;
        }

        const webhooks = await Server().repo.getWebhooks();
        // FIX: Pre-parse event types to avoid repeated JSON.parse on every dispatch
        this.webhookCache = webhooks.map(webhook => ({
            webhook,
            eventTypes: JSON.parse(webhook.events) as string[]
        }));
        this.cacheExpiry = now + this.CACHE_TTL_MS;
        return this.webhookCache;
    }

    async dispatch(event: WebhookEvent) {
        const cachedWebhooks = await this.getWebhooksWithCache();

        // FIX: Filter applicable webhooks first, then dispatch in parallel
        const applicableWebhooks = cachedWebhooks.filter(({ eventTypes }) =>
            eventTypes.includes("*") || eventTypes.includes(event.type)
        );

        if (applicableWebhooks.length === 0) return;

        // FIX: Dispatch to all applicable webhooks in parallel instead of sequentially
        const dispatchPromises = applicableWebhooks.map(({ webhook }) => {
            this.log.debug(`Dispatching event to webhook: ${webhook.url}`);
            return this.sendPost(webhook.url, event).catch(ex => {
                this.log.debug(`Failed to dispatch "${event.type}" event to webhook: ${webhook.url}`);
                this.log.debug(`  -> Error: ${ex?.message ?? String(ex)}`);
                this.log.debug(`  -> Status Text: ${ex?.response?.statusText}`);
            });
        });

        // Fire and forget, but ensure all are initiated
        Promise.all(dispatchPromises).catch(() => {
            // Errors already logged per-webhook
        });
    }

    private async sendPost(url: string, event: WebhookEvent) {
        return await axios.post(url, event, { headers: { "Content-Type": "application/json" } });
    }
}
