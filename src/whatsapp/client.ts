import { randomUUID } from 'node:crypto';

export type MediaKind = 'image' | 'video' | 'document';

/** A file already uploaded to WhatsApp (see `uploadMedia`). */
export interface MediaAttachment {
  kind: MediaKind;
  /** WhatsApp media id. */
  id: string;
  /** Shown to the recipient for documents. */
  filename: string;
}

export interface TemplateMessage {
  name: string;
  language: string;
  /** Values for the template body's {{1}}, {{2}}, ... placeholders, in order. */
  bodyParams: string[];
  /** For templates created with an image, video or document header. */
  header?: MediaAttachment;
}

export interface SendResult {
  /** WhatsApp message id, used to match later delivery/read status webhooks. */
  wamid: string;
}

export interface WhatsAppClient {
  /** Free-form text. Only delivered within 24h of the user's last message to you. */
  sendText(to: string, body: string): Promise<SendResult>;
  /** Pre-approved template. Can be sent at any time to users who opted in. */
  sendTemplate(to: string, template: TemplateMessage): Promise<SendResult>;
  /** Image, video or document with an optional caption. Same 24h rule as text. */
  sendMedia(to: string, media: MediaAttachment, caption?: string): Promise<SendResult>;
  /** Uploads a file to WhatsApp and returns its media id (valid for 30 days). */
  uploadMedia(data: Uint8Array, mimeType: string, filename: string): Promise<string>;
}

export class WhatsAppApiError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
    readonly code?: number,
  ) {
    super(message);
    this.name = 'WhatsAppApiError';
  }
}

// ─── Official Cloud API ─────────────────────────────────────────────────────

export interface CloudClientOptions {
  accessToken: string;
  phoneNumberId: string;
  apiVersion: string;
  fetch?: typeof fetch;
  maxRetries?: number;
}

/** Error codes WhatsApp uses for throttling; worth retrying after a pause. */
const RETRYABLE_CODES = new Set([4, 80007, 130429, 131056]);

export class CloudWhatsAppClient implements WhatsAppClient {
  private readonly fetch: typeof fetch;
  private readonly maxRetries: number;

  constructor(private readonly options: CloudClientOptions) {
    this.fetch = options.fetch ?? fetch;
    this.maxRetries = options.maxRetries ?? 3;
  }

  sendText(to: string, body: string): Promise<SendResult> {
    return this.post({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { body, preview_url: false },
    });
  }

  sendTemplate(to: string, template: TemplateMessage): Promise<SendResult> {
    const components: unknown[] = [];
    if (template.header) {
      const { kind, id, filename } = template.header;
      components.push({
        type: 'header',
        parameters: [{ type: kind, [kind]: { id, ...(kind === 'document' && { filename }) } }],
      });
    }
    if (template.bodyParams.length > 0) {
      components.push({ type: 'body', parameters: template.bodyParams.map((text) => ({ type: 'text', text })) });
    }
    return this.post({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'template',
      template: {
        name: template.name,
        language: { code: template.language },
        ...(components.length > 0 && { components }),
      },
    });
  }

  sendMedia(to: string, media: MediaAttachment, caption?: string): Promise<SendResult> {
    return this.post({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: media.kind,
      [media.kind]: {
        id: media.id,
        ...(caption && { caption }),
        ...(media.kind === 'document' && { filename: media.filename }),
      },
    });
  }

  async uploadMedia(data: Uint8Array, mimeType: string, filename: string): Promise<string> {
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', mimeType);
    form.append('file', new Blob([new Uint8Array(data)], { type: mimeType }), filename);
    const result = await this.request<{ id?: string }>('media', form);
    if (!result.id) throw new WhatsAppApiError('Upload did not return a media id', 200);
    return result.id;
  }

  private async post(payload: unknown): Promise<SendResult> {
    const data = await this.request<{ messages?: { id: string }[] }>('messages', JSON.stringify(payload));
    const wamid = data.messages?.[0]?.id;
    if (!wamid) throw new WhatsAppApiError('WhatsApp did not return a message id', 200);
    return { wamid };
  }

  private async request<T>(endpoint: 'messages' | 'media', body: string | FormData): Promise<T> {
    const { apiVersion, phoneNumberId, accessToken } = this.options;
    const url = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/${endpoint}`;
    const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}` };
    if (typeof body === 'string') headers['Content-Type'] = 'application/json';

    for (let attempt = 0; ; attempt++) {
      const res = await this.fetch(url, { method: 'POST', headers, body });
      const data = (await res.json().catch(() => ({}))) as T & {
        error?: { message?: string; code?: number; error_data?: { details?: string } };
      };

      if (res.ok && !data.error) return data;

      const code = data.error?.code;
      const retryable = res.status === 429 || res.status >= 500 || (code !== undefined && RETRYABLE_CODES.has(code));
      if (retryable && attempt < this.maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
        continue;
      }
      const detail = data.error?.error_data?.details;
      const message = [data.error?.message ?? `HTTP ${res.status}`, detail].filter(Boolean).join(' — ');
      throw new WhatsAppApiError(message, res.status, code);
    }
  }
}

// ─── Mock (local development) ───────────────────────────────────────────────

export interface OutboxEntry {
  wamid: string;
  to: string;
  kind: 'text' | 'template' | 'media';
  text: string;
  attachment?: { kind: MediaKind; filename: string };
  at: number;
}

/** Sends nothing. Keeps the last few hundred "sent" messages so the dashboard Simulator can show them. */
export class MockWhatsAppClient implements WhatsAppClient {
  readonly outbox: OutboxEntry[] = [];
  /** Called after each "send", e.g. to simulate receipts. */
  onSent?: (wamid: string) => void;

  constructor(private readonly log: (line: string) => void = console.log) {}

  async sendText(to: string, body: string): Promise<SendResult> {
    return this.record(to, 'text', body);
  }

  async sendTemplate(to: string, template: TemplateMessage): Promise<SendResult> {
    const params = template.bodyParams.map((p, i) => `{{${i + 1}}}=${JSON.stringify(p)}`).join(' ');
    return this.record(to, 'template', `[template ${template.name} (${template.language})] ${params}`.trim(), template.header);
  }

  async sendMedia(to: string, media: MediaAttachment, caption?: string): Promise<SendResult> {
    return this.record(to, 'media', caption ?? '', media);
  }

  async uploadMedia(_data: Uint8Array, _mimeType: string, filename: string): Promise<string> {
    this.log(`[mock whatsapp] uploaded ${filename}`);
    return `mock-media-${randomUUID()}`;
  }

  private record(to: string, kind: OutboxEntry['kind'], text: string, media?: MediaAttachment): SendResult {
    const wamid = `wamid.mock-${randomUUID()}`;
    if (media) this.log(`[mock whatsapp] → ${to}: 📎 ${media.kind} ${media.filename}`);
    this.outbox.unshift({ wamid, to, kind, text, attachment: media && { kind: media.kind, filename: media.filename }, at: Date.now() });
    this.outbox.length = Math.min(this.outbox.length, 500);
    this.onSent?.(wamid);
    this.log(`[mock whatsapp] → ${to}: ${text.replace(/\n/g, ' ⏎ ')}`);
    return { wamid };
  }
}
