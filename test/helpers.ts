import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/db.js';
import { MediaLibrary } from '../src/media.js';
import type { InboundWhatsAppMessage, WebhookPayload } from '../src/inbound.js';
import { Store } from '../src/store.js';
import { MockWhatsAppClient } from '../src/whatsapp/client.js';

export function setup(startAt = Date.UTC(2026, 0, 1, 9)) {
  const clock = { now: startAt };
  const store = new Store(openDatabase(':memory:'));
  const client = new MockWhatsAppClient(() => {});
  const media = new MediaLibrary(store, client, mkdtempSync(join(tmpdir(), 'wa-lists-test-')));
  return { store, client, media, clock, now: () => clock.now };
}

let seq = 0;
export function textMessage(from: string, body: string): InboundWhatsAppMessage {
  return { id: `wamid.test-${++seq}`, from, type: 'text', text: { body } };
}

export function payload(value: NonNullable<NonNullable<NonNullable<WebhookPayload['entry']>[number]['changes']>[number]['value']>): WebhookPayload {
  return { object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value }] }] };
}
