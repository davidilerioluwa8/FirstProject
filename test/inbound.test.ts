import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handleWebhookPayload } from '../src/inbound.js';
import { payload, setup, textMessage } from './helpers.js';

function harness() {
  const ctx = setup();
  const list = ctx.store.createList({ name: 'Weekly News', slug: 'news', welcomeMessage: 'Welcome aboard!' }, ctx.now());
  const send = (from: string, text: string, name = 'Ada') =>
    handleWebhookPayload(payload({ contacts: [{ wa_id: from, profile: { name } }], messages: [textMessage(from, text)] }), ctx);
  const lastReply = () => ctx.client.outbox[0]?.text;
  return { ...ctx, list, send, lastReply };
}

test('JOIN subscribes an unknown number and sends the welcome message', async () => {
  const h = harness();
  await h.send('2348000000001', 'JOIN news');

  const [member] = h.store.listMembers(h.list.id);
  assert.equal(member.waId, '2348000000001');
  assert.equal(member.name, 'Ada');
  assert.equal(member.status, 'active');
  assert.match(h.lastReply()!, /^Welcome aboard!/);
  assert.match(h.lastReply()!, /STOP news/);
});

test('joining twice does not duplicate the membership', async () => {
  const h = harness();
  await h.send('2348000000001', 'join news');
  await h.send('2348000000001', 'JOIN NEWS');
  assert.equal(h.store.listMembers(h.list.id).length, 1);
  assert.match(h.lastReply()!, /already on/);
});

test('unknown list names get a helpful reply and no membership', async () => {
  const h = harness();
  await h.send('2348000000001', 'JOIN sports');
  assert.equal(h.store.listMembers(h.list.id).length, 0);
  assert.match(h.lastReply()!, /couldn't find a list called "sports"/);
});

test('STOP <list> leaves one list; rejoining reactivates it', async () => {
  const h = harness();
  const other = h.store.createList({ name: 'Events', slug: 'events' }, h.now());
  await h.send('2348000000001', 'JOIN news');
  await h.send('2348000000001', 'JOIN events');
  await h.send('2348000000001', 'STOP news');

  assert.equal(h.store.listMembers(h.list.id)[0].status, 'unsubscribed');
  assert.equal(h.store.listMembers(other.id)[0].status, 'active');

  await h.send('2348000000001', 'JOIN news');
  assert.equal(h.store.listMembers(h.list.id)[0].status, 'active');
});

test('STOP alone and template opt-out buttons leave every list', async () => {
  const h = harness();
  h.store.createList({ name: 'Events', slug: 'events' }, h.now());
  await h.send('2348000000001', 'JOIN news');
  await h.send('2348000000001', 'JOIN events');
  await h.send('2348000000001', 'STOP');
  const sub = h.store.listMembers(h.list.id)[0];
  assert.equal(h.store.activeListsFor(sub.id).length, 0);

  await h.send('2348000000001', 'JOIN news');
  await handleWebhookPayload(
    payload({ messages: [{ id: 'wamid.btn', from: '2348000000001', type: 'button', button: { text: 'Stop promotions' } }] }),
    h,
  );
  assert.equal(h.store.activeListsFor(sub.id).length, 0);
});

test('chatty replies from members are recorded without an auto-reply', async () => {
  const h = harness();
  await h.send('2348000000001', 'JOIN news');
  const before = h.client.outbox.length;
  await h.send('2348000000001', 'thank you!');
  assert.equal(h.client.outbox.length, before);
  assert.equal(h.store.listInbound()[0].text, 'thank you!');
});

test('non-members sending random text get the help menu', async () => {
  const h = harness();
  await h.send('2348000000009', 'hello?');
  assert.match(h.lastReply()!, /JOIN <list>/);
});

test('retried webhooks are processed only once', async () => {
  const h = harness();
  const msg = textMessage('2348000000001', 'JOIN news');
  const body = payload({ messages: [msg] });
  await handleWebhookPayload(body, h);
  await handleWebhookPayload(body, h);
  assert.equal(h.client.outbox.length, 1);
  assert.equal(h.store.listInbound().length, 1);
});

test('status webhooks move deliveries forward but never backwards', async () => {
  const h = harness();
  await h.send('2348000000001', 'JOIN news');
  const message = h.store.createMessage({ listId: h.list.id, kind: 'template', templateName: 'hello_world', sendAt: h.now() }, h.now());
  h.store.startSending(message.id, h.now());
  const [pending] = h.store.pendingDeliveries(message.id);
  h.store.setDeliveryResult(pending.deliveryId, { status: 'accepted', wamid: 'wamid.out-1' }, h.now());

  const status = (s: string) => handleWebhookPayload(payload({ statuses: [{ id: 'wamid.out-1', status: s }] }), h);
  await status('read');
  await status('delivered');
  assert.equal(h.store.listDeliveries(message.id)[0].status, 'read');

  await handleWebhookPayload(
    payload({ statuses: [{ id: 'wamid.out-1', status: 'failed', errors: [{ code: 131026, title: 'Message undeliverable' }] }] }),
    h,
  );
  const [delivery] = h.store.listDeliveries(message.id);
  assert.equal(delivery.status, 'failed');
  assert.match(delivery.error!, /131026/);
});
