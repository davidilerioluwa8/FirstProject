import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handleWebhookPayload } from '../src/inbound.js';
import { MediaError, detectMimeType } from '../src/media.js';
import { normalizePhone } from '../src/phone.js';
import { Scheduler } from '../src/scheduler.js';
import { payload, setup, textMessage } from './helpers.js';

const HOUR = 3600e3;
const PDF = new TextEncoder().encode('%PDF-1.4 quotation');

function harness() {
  const ctx = setup();
  const send = (from: string, text: string, name = 'Ada') =>
    handleWebhookPayload(payload({ contacts: [{ wa_id: from, profile: { name } }], messages: [textMessage(from, text)] }), ctx);
  return { ...ctx, send, lastOut: () => ctx.client.outbox[0] };
}

test('normalizePhone handles international, 00 and local formats', () => {
  assert.equal(normalizePhone('+234 803 123 4567'), '2348031234567');
  assert.equal(normalizePhone('00447700900123'), '447700900123');
  assert.equal(normalizePhone('0803 123 4567', '234'), '2348031234567');
  assert.equal(normalizePhone('0803 123 4567'), null, 'local number without a country code');
  assert.equal(normalizePhone('2348031234567'), '2348031234567');
  assert.equal(normalizePhone('12345'), null);
  assert.equal(normalizePhone('not a number'), null);
});

test('keyword auto-reply sends the text and attached document, case-insensitively', async () => {
  const h = harness();
  const file = await h.media.save(PDF, 'Account details.pdf', 'application/pdf', h.now());
  h.store.createAutoReply({ keyword: 'account', action: 'reply', replyText: 'Here are our bank details 👇', mediaId: file.id }, h.now());

  await h.send('2348000000001', 'Account please!');
  const out = h.lastOut();
  assert.equal(out.kind, 'media');
  assert.equal(out.text, 'Here are our bank details 👇');
  assert.deepEqual(out.attachment, { kind: 'document', filename: 'Account details.pdf' });

  const [auto] = h.store.listAutoReplies();
  assert.equal(auto.keyword, 'ACCOUNT');
  assert.equal(auto.hitCount, 1);
  assert.equal(h.store.listInbound()[0].handledAs, 'keyword:ACCOUNT');
});

test('the WhatsApp upload is reused for later sends of the same file', async () => {
  const h = harness();
  let uploads = 0;
  const upload = h.client.uploadMedia.bind(h.client);
  h.client.uploadMedia = async (...args) => (uploads++, upload(...args));
  const file = await h.media.save(PDF, 'q.pdf', 'application/pdf', h.now());
  h.store.createAutoReply({ keyword: 'QUOTE', action: 'reply', replyText: '', mediaId: file.id }, h.now());

  await h.send('2348000000001', 'quote');
  await h.send('2348000000002', 'QUOTE');
  assert.equal(uploads, 1);
});

test('auto-replies do not override built-in commands', async () => {
  const h = harness();
  const list = h.store.createList({ name: 'News', slug: 'news' }, h.now());
  await h.send('2348000000001', 'JOIN news');
  h.store.createAutoReply({ keyword: 'NEWS', action: 'reply', replyText: 'auto' }, h.now());
  await h.send('2348000000001', 'STOP news');
  assert.equal(h.store.listMembers(list.id)[0].status, 'unsubscribed');
  assert.notEqual(h.lastOut().text, 'auto');
});

test('"talk to me" alerts the owner by text when they are inside the 24h window', async () => {
  const h = harness();
  h.store.updateSettings({ ownerPhone: '2348099999999', ownerName: 'David' });
  h.store.createAutoReply({ keyword: 'CALL ME', action: 'handoff' }, h.now());
  await h.send('2348099999999', 'hi', 'Owner'); // owner opens their 24h window

  await h.send('2348000000001', 'Call me, about the quotation', 'Ada');
  const toOwner = h.client.outbox.find((o) => o.to === '2348099999999' && o.text.includes('Call-back request'));
  assert.ok(toOwner, 'owner was alerted');
  assert.match(toOwner.text, /Ada\* \(\+2348000000001\)/);
  assert.match(toOwner.text, /wa\.me\/2348000000001/);
  assert.match(h.client.outbox.find((o) => o.to === '2348000000001')!.text, /David will get back to you/);

  const [request] = h.store.listHandoffs();
  assert.equal(request.status, 'open');
  assert.equal(request.notifyStatus, 'sent');

  // Asking again shortly after doesn't alert the owner twice.
  const before = h.client.outbox.filter((o) => o.to === '2348099999999').length;
  await h.send('2348000000001', 'CALL ME');
  assert.equal(h.client.outbox.filter((o) => o.to === '2348099999999').length, before);
  assert.equal(h.store.listHandoffs().length, 1);
});

test('"talk to me" falls back to the notification template, and records failures', async () => {
  const h = harness();
  h.store.createAutoReply({ keyword: 'AGENT', action: 'handoff' }, h.now());

  await h.send('2348000000001', 'agent');
  assert.equal(h.store.listHandoffs()[0].notifyStatus, 'not_configured');

  h.store.updateSettings({ ownerPhone: '2348099999999' });
  await h.send('2348000000002', 'agent');
  const noTemplate = h.store.listHandoffs().find((r) => r.waId === '2348000000002')!;
  assert.equal(noTemplate.notifyStatus, 'failed');
  assert.match(noTemplate.notifyError!, /notification template/);

  h.store.updateSettings({ notifyTemplateName: 'callback_request' });
  await h.send('2348000000003', 'agent\nplease', 'Tunde');
  const viaTemplate = h.client.outbox.find((o) => o.to === '2348099999999')!;
  assert.match(viaTemplate.text, /\[template callback_request/);
  assert.match(viaTemplate.text, /"Tunde".*"\+2348000000003".*"agent please"/);
});

test('contacts added by hand join the list, but people who left are never re-added', async () => {
  const h = harness();
  const list = h.store.createList({ name: 'Customers', slug: 'customers' }, h.now());
  assert.equal(h.store.addContact(list.id, '2348000000001', 'Ada', h.now()), 'added');
  assert.equal(h.store.addContact(list.id, '2348000000001', 'Ada', h.now()), 'already_member');
  assert.equal(h.store.listMembers(list.id)[0].source, 'manual');

  await h.send('2348000000001', 'STOP customers');
  assert.equal(h.store.addContact(list.id, '2348000000001', 'Ada', h.now()), 'opted_out');
  assert.equal(h.store.listMembers(list.id)[0].status, 'unsubscribed');
});

test('campaigns can carry an attachment as a template header', async () => {
  const h = harness();
  const list = h.store.createList({ name: 'Customers', slug: 'customers' }, h.now());
  h.store.addContact(list.id, '2348000000001', 'Ada', h.now());
  const file = await h.media.save(PDF, 'Quotation.pdf', 'application/pdf', h.now());
  h.store.createMessage({ listId: list.id, kind: 'template', templateName: 'quotation', mediaId: file.id, sendAt: h.now() }, h.now());

  await new Scheduler({ ...h, ratePerSecond: 10, intervalMs: 1000, log: () => {} }).tick();
  assert.deepEqual(h.lastOut().attachment, { kind: 'document', filename: 'Quotation.pdf' });
});

test('rejects file types and sizes WhatsApp would refuse', async () => {
  const h = harness();
  assert.equal(detectMimeType('application/octet-stream', 'price list.XLSX'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  await assert.rejects(h.media.save(new Uint8Array(10), 'tool.exe', 'application/x-msdownload', h.now()), MediaError);
  await assert.rejects(h.media.save(new Uint8Array(6 * 1024 * 1024), 'big.png', 'image/png', h.now()), /5 MB/);
});

test('stats count delivery, reads, replies and daily joins', async () => {
  const h = harness();
  const list = h.store.createList({ name: 'News', slug: 'news' }, h.now());
  await h.send('2348000000001', 'JOIN news');
  await h.send('2348000000002', 'JOIN news');
  await h.send('2348000000003', 'JOIN news');
  await h.send('2348000000003', 'STOP news');
  h.clock.now += HOUR;

  const msg = h.store.createMessage({ listId: list.id, kind: 'template', templateName: 'weekly', sendAt: h.now() }, h.now());
  await new Scheduler({ ...h, ratePerSecond: 10, intervalMs: 1000, log: () => {} }).tick();
  const [a, b] = h.store.listDeliveries(msg.id);
  h.store.applyStatusUpdate(a.wamid!, 'read', null, h.now());
  h.store.applyStatusUpdate(b.wamid!, 'delivered', null, h.now());
  h.clock.now += HOUR;
  await h.send('2348000000001', 'Thanks!');

  const stats = h.store.stats(h.now(), 7, 0);
  const [c] = stats.campaigns;
  assert.equal(c.recipients, 2);
  assert.equal(c.sent, 2);
  assert.equal(c.delivered, 2);
  assert.equal(c.read, 1);
  assert.equal(c.replied, 1);
  assert.equal(stats.totals.activeSubscribers, 2);
  assert.equal(stats.totals.joined, 3);
  assert.equal(stats.totals.left, 1);
  assert.equal(stats.daily.length, 7);
  assert.equal(stats.daily.at(-1)!.joined, 3);
  assert.equal(stats.daily.at(-1)!.left, 1);
});
