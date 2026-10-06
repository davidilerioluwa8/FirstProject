import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SERVICE_WINDOW_MS, Scheduler, personalize } from '../src/scheduler.js';
import type { WhatsAppClient } from '../src/whatsapp/client.js';
import { setup } from './helpers.js';

const HOUR = 60 * 60 * 1000;

function harness(opts: { ratePerSecond?: number; client?: WhatsAppClient } = {}) {
  const ctx = setup();
  const sleeps: number[] = [];
  const list = ctx.store.createList({ name: 'News', slug: 'news' }, ctx.now());
  const addMember = (waId: string, name: string) => {
    const s = ctx.store.touchSubscriber(waId, name, ctx.now());
    ctx.store.subscribe(list.id, s.id, ctx.now());
    return s;
  };
  const scheduler = new Scheduler({
    store: ctx.store,
    client: opts.client ?? ctx.client,
    media: ctx.media,
    ratePerSecond: opts.ratePerSecond ?? 10,
    intervalMs: 1000,
    now: ctx.now,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    log: () => {},
  });
  return { ...ctx, list, addMember, scheduler, sleeps };
}

test('personalize fills {{name}} with a fallback', () => {
  assert.equal(personalize('Hi {{name}}!', { name: 'Ada' }), 'Hi Ada!');
  assert.equal(personalize('Hi {{ NAME }}!', { name: '' }), 'Hi there!');
});

test('sends a scheduled template only once its time arrives, personalised per subscriber', async () => {
  const h = harness();
  h.addMember('2348000000001', 'Ada');
  h.addMember('2348000000002', 'Tunde');
  const msg = h.store.createMessage(
    { listId: h.list.id, kind: 'template', templateName: 'weekly_update', templateLanguage: 'en_US', templateParams: ['{{name}}', 'Monday news'], sendAt: h.now() + HOUR },
    h.now(),
  );

  await h.scheduler.tick();
  assert.equal(h.client.outbox.length, 0);
  assert.equal(h.store.getMessage(msg.id)!.status, 'scheduled');

  h.clock.now += HOUR;
  await h.scheduler.tick();
  assert.equal(h.store.getMessage(msg.id)!.status, 'sent');
  assert.equal(h.client.outbox.length, 2);
  assert.ok(h.client.outbox.some((o) => o.to === '2348000000001' && o.text.includes('"Ada"')));
  assert.ok(h.client.outbox.some((o) => o.to === '2348000000002' && o.text.includes('"Tunde"')));
  assert.equal(h.store.deliveryCounts(msg.id).accepted, 2);

  await h.scheduler.tick();
  assert.equal(h.client.outbox.length, 2, 'not sent again');
});

test('unsubscribed members and cancelled messages are not sent', async () => {
  const h = harness();
  h.addMember('2348000000001', 'Ada');
  const gone = h.addMember('2348000000002', 'Tunde');
  h.store.unsubscribe(h.list.id, gone.id, h.now());
  const cancelled = h.store.createMessage({ listId: h.list.id, kind: 'template', templateName: 'a', sendAt: h.now() }, h.now());
  h.store.cancelMessage(cancelled.id);
  const live = h.store.createMessage({ listId: h.list.id, kind: 'template', templateName: 'b', sendAt: h.now() }, h.now());

  await h.scheduler.tick();
  assert.equal(h.store.getMessage(cancelled.id)!.status, 'cancelled');
  assert.deepEqual(h.client.outbox.map((o) => o.to), ['2348000000001']);
  assert.equal(h.store.deliveryCounts(live.id).total, 1);
});

test('free text skips people outside the 24h service window', async () => {
  const h = harness();
  h.addMember('2348000000001', 'Stale');
  h.clock.now += SERVICE_WINDOW_MS + 1;
  h.addMember('2348000000002', 'Recent');
  const msg = h.store.createMessage({ listId: h.list.id, kind: 'text', body: 'Hi {{name}}', sendAt: h.now() }, h.now());

  await h.scheduler.tick();
  assert.deepEqual(h.client.outbox.map((o) => o.text), ['Hi Recent']);
  const counts = h.store.deliveryCounts(msg.id);
  assert.equal(counts.accepted, 1);
  assert.equal(counts.skipped, 1);
});

test('API errors are recorded per recipient; all-failed messages are marked failed', async () => {
  const failing: WhatsAppClient = {
    sendText: async () => ({ wamid: 'x' }),
    sendTemplate: async () => {
      throw new Error('(#132001) Template name does not exist in the translation');
    },
    sendMedia: async () => ({ wamid: 'x' }),
    uploadMedia: async () => 'x',
  };
  const h = harness({ client: failing });
  h.addMember('2348000000001', 'Ada');
  const msg = h.store.createMessage({ listId: h.list.id, kind: 'template', templateName: 'missing', sendAt: h.now() }, h.now());

  await h.scheduler.tick();
  assert.equal(h.store.getMessage(msg.id)!.status, 'failed');
  assert.match(h.store.listDeliveries(msg.id)[0].error!, /132001/);
});

test('resumes a half-sent message after a restart without re-sending', async () => {
  const h = harness();
  h.addMember('2348000000001', 'Ada');
  h.addMember('2348000000002', 'Tunde');
  const msg = h.store.createMessage({ listId: h.list.id, kind: 'template', templateName: 'a', sendAt: h.now() }, h.now());
  // Simulate a crash after the first recipient was sent.
  h.store.startSending(msg.id, h.now());
  const [first] = h.store.pendingDeliveries(msg.id);
  h.store.setDeliveryResult(first.deliveryId, { status: 'accepted', wamid: 'wamid.before-crash' }, h.now());

  await h.scheduler.tick();
  assert.deepEqual(h.client.outbox.map((o) => o.to), ['2348000000002']);
  assert.equal(h.store.getMessage(msg.id)!.status, 'sent');
});

test('throttles to the configured rate', async () => {
  const h = harness({ ratePerSecond: 2 });
  for (let i = 1; i <= 5; i++) h.addMember(`23480000000${i.toString().padStart(2, '0')}`, `P${i}`);
  h.store.createMessage({ listId: h.list.id, kind: 'template', templateName: 'a', sendAt: h.now() }, h.now());

  await h.scheduler.tick();
  assert.equal(h.client.outbox.length, 5);
  assert.deepEqual(h.sleeps, [1000, 1000], '3 batches → 2 pauses');
});
