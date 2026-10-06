import { randomUUID } from 'node:crypto';

export interface TemplateMessage {
  name: string;
  language: string;
  /** Values for the template body's {{1}}, {{2}}, ... placeholders, in order. */
  bodyParams: string[];
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
    return this.post({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'template',
      template: {
        name: template.name,
        language: { code: template.language },
        ...(template.bodyParams.length > 0 && {
          components: [{ type: 'body', parameters: template.bodyParams.map((text) => ({ type: 'text', text })) }],
        }),
      },
    });
  }

  private async post(payload: unknown): Promise<SendResult> {
    const { apiVersion, phoneNumberId, accessToken } = this.options;
    const url = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`;

    for (let attempt = 0; ; attempt++) {
      const res = await this.fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = (await res.json().catch(() => ({}))) as {
        messages?: { id: string }[];
        error?: { message?: string; code?: number; error_data?: { details?: string } };
      };

      if (res.ok && data.messages?.[0]?.id) return { wamid: data.messages[0].id };

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
  kind: 'text' | 'template';
  text: string;
  at: number;
}

/** Sends nothing. Keeps the last few hundred "sent" messages so the dashboard Simulator can show them. */
export class MockWhatsAppClient implements WhatsAppClient {
  readonly outbox: OutboxEntry[] = [];

  constructor(private readonly log: (line: string) => void = console.log) {}

  async sendText(to: string, body: string): Promise<SendResult> {
    return this.record(to, 'text', body);
  }

  async sendTemplate(to: string, template: TemplateMessage): Promise<SendResult> {
    const params = template.bodyParams.map((p, i) => `{{${i + 1}}}=${JSON.stringify(p)}`).join(' ');
    return this.record(to, 'template', `[template ${template.name} (${template.language})] ${params}`.trim());
  }

  private record(to: string, kind: OutboxEntry['kind'], text: string): SendResult {
    const wamid = `wamid.mock-${randomUUID()}`;
    this.outbox.unshift({ wamid, to, kind, text, at: Date.now() });
    this.outbox.length = Math.min(this.outbox.length, 500);
    this.log(`[mock whatsapp] → ${to}: ${text.replace(/\n/g, ' ⏎ ')}`);
    return { wamid };
  }
}
