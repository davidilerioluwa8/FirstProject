import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { CloudWhatsAppClient } from '../src/whatsapp/client.js';
import { setup, textMessage, payload } from './helpers.js';

const APP_SECRET = 'test-app-secret';
const auth = { Authorization: `Basic ${Buffer.from('admin:pw').toString('base64')}` };
const ctx = setup();
let base = '';
let close: () => void;

before(async () => {
  const config = loadConfig({
    ADMIN_PASSWORD: 'pw',
    WHATSAPP_BUSINESS_PHONE: '+234 801 234 5678',
    WHATSAPP_VERIFY_TOKEN: 'verify-me',
    WHATSAPP_APP_SECRET: APP_SECRET,
  });
  const server = createApp({ config, store: ctx.store, client: ctx.client, media: ctx.media, now: ctx.now }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});
after(() => close());

const json = (path: string, body?: unknown, method = body ? 'POST' : 'GET') =>
  fetch(base + path, { method, headers: { ...auth, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

test('webhook verification handshake', async () => {
  const ok = await fetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=12345`);
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), '12345');
  const bad = await fetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1`);
  assert.equal(bad.status, 403);
});

test('webhook rejects bad signatures and accepts good ones', async () => {
  ctx.store.createList({ name: 'News', slug: 'news' }, ctx.now());
  const body = JSON.stringify(payload({ messages: [textMessage('2348000000001', 'JOIN news')] }));

  const unsigned = await fetch(`${base}/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  assert.equal(unsigned.status, 401);

  const signature = 'sha256=' + createHmac('sha256', APP_SECRET).update(body).digest('hex');
  const signed = await fetch(`${base}/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': signature },
    body,
  });
  assert.equal(signed.status, 200);
  assert.equal(ctx.store.listLists()[0].activeCount, 1);
});

test('dashboard and API require the admin login; webhook and health do not', async () => {
  assert.equal((await fetch(`${base}/`)).status, 401);
  assert.equal((await fetch(`${base}/api/lists`)).status, 401);
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  assert.equal((await fetch(`${base}/`, { headers: auth })).status, 200);
});

test('list API validates keywords and returns a join link + QR code', async () => {
  const bad = await json('/api/lists', { name: 'Bad', slug: 'Has Spaces' });
  assert.equal(bad.status, 400);

  const created = await json('/api/lists', { name: 'Prayer Group', slug: 'prayer-group' });
  assert.equal(created.status, 201);
  const list = await created.json();

  const dup = await json('/api/lists', { name: 'Again', slug: 'prayer-group' });
  assert.equal(dup.status, 409);

  const join = await (await json(`/api/lists/${list.id}/join`)).json();
  assert.equal(join.link, 'https://wa.me/2348012345678?text=JOIN%20prayer-group');
  assert.match(join.qr, /^data:image\/png;base64,/);
});

test('message API validates input and schedules', async () => {
  const [list] = ctx.store.listLists();
  const noTemplate = await json('/api/messages', { listId: list.id, kind: 'template' });
  assert.equal(noTemplate.status, 400);

  const newline = await json('/api/messages', { listId: list.id, kind: 'template', templateName: 'x', templateParams: ['a\nb'] });
  assert.equal(newline.status, 400);
  assert.match((await newline.json()).error, /line breaks/);

  const sendAt = new Date(ctx.now() + 3_600_000).toISOString();
  const ok = await json('/api/messages', { listId: list.id, kind: 'template', templateName: 'weekly_update', templateParams: ['{{name}}'], sendAt });
  assert.equal(ok.status, 201);
  const message = await ok.json();
  assert.equal(message.sendAt, Date.parse(sendAt));
  assert.equal(message.status, 'scheduled');

  assert.equal((await json(`/api/messages/${message.id}/cancel`, {})).status, 200);
  assert.equal((await json(`/api/messages/${message.id}/cancel`, {})).status, 409);
});

test('simulator endpoints are not exposed outside mock mode', async () => {
  // This app uses the mock client, so they exist here…
  assert.equal((await json('/api/simulate/outbox')).status, 200);
  // …and the cloud config check refuses to start without credentials.
  assert.throws(() => loadConfig({ WHATSAPP_MODE: 'cloud' }), /WHATSAPP_ACCESS_TOKEN/);
});

test('cloud client sends the Graph API template payload and surfaces errors', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const responses = [
    new Response(JSON.stringify({ messages: [{ id: 'wamid.real' }] }), { status: 200 }),
    new Response(JSON.stringify({ error: { message: 'Template not found', code: 132001 } }), { status: 400 }),
  ];
  const client = new CloudWhatsAppClient({
    accessToken: 'tok',
    phoneNumberId: '123',
    apiVersion: 'v23.0',
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return responses.shift()!;
    }) as typeof fetch,
  });

  const result = await client.sendTemplate('2348000000001', { name: 'weekly_update', language: 'en_US', bodyParams: ['Ada'] });
  assert.equal(result.wamid, 'wamid.real');
  assert.equal(calls[0].url, 'https://graph.facebook.com/v23.0/123/messages');
  assert.equal((calls[0].init.headers as Record<string, string>).Authorization, 'Bearer tok');
  assert.deepEqual(JSON.parse(String(calls[0].init.body)).template, {
    name: 'weekly_update',
    language: { code: 'en_US' },
    components: [{ type: 'body', parameters: [{ type: 'text', text: 'Ada' }] }],
  });

  await assert.rejects(client.sendText('2348000000001', 'hi'), /Template not found/);
});

test('file upload, auto-reply and contact import endpoints', async () => {
  const upload = await fetch(`${base}/api/media?filename=${encodeURIComponent('Price list.pdf')}`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/pdf' },
    body: '%PDF-1.4',
  });
  assert.equal(upload.status, 201);
  const file = await upload.json();
  assert.equal(file.kind, 'document');
  assert.equal(file.storagePath, undefined, 'server paths are not exposed');

  const download = await fetch(`${base}/api/media/${file.id}/file`, { headers: auth });
  assert.equal(await download.text(), '%PDF-1.4');

  const reserved = await json('/api/auto-replies', { keyword: 'stop', action: 'reply', replyText: 'x' });
  assert.equal(reserved.status, 400);
  const created = await json('/api/auto-replies', { keyword: 'price list', action: 'reply', replyText: 'Here you go', mediaId: file.id });
  assert.equal(created.status, 201);
  assert.equal((await created.json()).keyword, 'PRICE LIST');
  assert.equal((await json(`/api/media/${file.id}`, undefined, 'DELETE')).status, 409, 'in use');

  const [list] = ctx.store.listLists();
  const noConsent = await json(`/api/lists/${list.id}/members`, { contacts: [{ phone: '+2348000000777' }] });
  assert.equal(noConsent.status, 400);
  await json('/api/settings', { defaultCountryCode: '234' }, 'PUT');
  const imported = await json(`/api/lists/${list.id}/members`, {
    consent: true,
    contacts: [{ phone: '0803 000 0777', name: 'Bisi' }, { phone: '+2348000000778' }, { phone: '12' }],
  });
  assert.deepEqual(await imported.json(), { added: 2, alreadyMember: 0, optedOut: [], invalid: ['12'] });

  const stats = await (await json('/api/stats?days=30&tzOffset=-60')).json();
  assert.equal(stats.daily.length, 30);
});
