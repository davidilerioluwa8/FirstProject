import { type MediaLibrary, sendRich } from './media.js';
import type { Message, PendingDelivery, Store, Subscriber } from './store.js';
import type { MediaAttachment, WhatsAppClient } from './whatsapp/client.js';

/** WhatsApp only delivers free-form text within 24h of the user's last message. */
export const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface SchedulerOptions {
  store: Store;
  client: WhatsAppClient;
  media: MediaLibrary;
  ratePerSecond: number;
  intervalMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

/** Replaces {{name}} with the subscriber's WhatsApp profile name. */
export function personalize(text: string, subscriber: Pick<Subscriber, 'name'>): string {
  const name = subscriber.name.trim() || 'there';
  return text.replace(/\{\{\s*name\s*\}\}/gi, name);
}

export class Scheduler {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (line: string) => void;

  constructor(private readonly options: SchedulerOptions) {
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.log = options.log ?? console.log;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.options.intervalMs);
    void this.tick();
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }

  /** Sends every due message. Overlapping calls share the same run. */
  tick(): Promise<void> {
    this.running ??= this.runDue().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async runDue(): Promise<void> {
    try {
      for (const message of this.options.store.dueMessages(this.now())) {
        await this.dispatch(message);
      }
    } catch (err) {
      this.log(`Scheduler error: ${(err as Error).stack ?? err}`);
    }
  }

  private async dispatch(message: Message): Promise<void> {
    const { store, ratePerSecond } = this.options;
    store.startSending(message.id, this.now());
    const pending = store.pendingDeliveries(message.id);
    if (pending.length > 0) this.log(`Sending message #${message.id} to ${pending.length} subscriber(s)`);

    let attachment: MediaAttachment | undefined;
    if (message.mediaId && pending.length > 0) {
      try {
        attachment = await this.options.media.attachment(message.mediaId, this.now());
      } catch (err) {
        const error = `Attachment could not be uploaded: ${(err as Error).message}`;
        for (const p of pending) store.setDeliveryResult(p.deliveryId, { status: 'failed', error }, this.now());
        pending.length = 0;
      }
    }

    for (let i = 0; i < pending.length; i += ratePerSecond) {
      const batchStarted = this.now();
      await Promise.all(pending.slice(i, i + ratePerSecond).map((p) => this.deliver(message, p, attachment)));
      const elapsed = this.now() - batchStarted;
      if (i + ratePerSecond < pending.length && elapsed < 1000) await this.sleep(1000 - elapsed);
    }

    const status = store.finishMessage(message.id, this.now());
    const counts = store.deliveryCounts(message.id);
    this.log(
      `Message #${message.id} ${status}: ${counts.total - counts.failed - counts.skipped} accepted, ` +
        `${counts.failed} failed, ${counts.skipped} skipped`,
    );
  }

  private async deliver(
    message: Message,
    { deliveryId, subscriber }: PendingDelivery,
    attachment: MediaAttachment | undefined,
  ): Promise<void> {
    const { store, client } = this.options;
    try {
      let wamid: string;
      if (message.kind === 'text') {
        const lastInbound = subscriber.lastInboundAt ?? 0;
        if (this.now() - lastInbound > SERVICE_WINDOW_MS) {
          store.setDeliveryResult(
            deliveryId,
            { status: 'skipped', error: 'Outside the 24h window; use a template message to reach this person' },
            this.now(),
          );
          return;
        }
        ({ wamid } = await sendRich(client, subscriber.waId, personalize(message.body ?? '', subscriber), attachment));
      } else {
        ({ wamid } = await client.sendTemplate(subscriber.waId, {
          name: message.templateName ?? '',
          language: message.templateLanguage ?? 'en_US',
          bodyParams: message.templateParams.map((p) => personalize(p, subscriber)),
          header: attachment,
        }));
      }
      store.setDeliveryResult(deliveryId, { status: 'accepted', wamid }, this.now());
    } catch (err) {
      store.setDeliveryResult(deliveryId, { status: 'failed', error: (err as Error).message }, this.now());
    }
  }
}
