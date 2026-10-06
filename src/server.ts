import { existsSync } from 'node:fs';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db.js';
import { MediaLibrary } from './media.js';
import { Scheduler } from './scheduler.js';
import { Store } from './store.js';
import { CloudWhatsAppClient, MockWhatsAppClient, type WhatsAppClient } from './whatsapp/client.js';

if (existsSync('.env')) process.loadEnvFile('.env');

const config = loadConfig();
const store = new Store(openDatabase(config.databasePath));
const client: WhatsAppClient =
  config.mode === 'cloud'
    ? new CloudWhatsAppClient({
        accessToken: config.whatsapp.accessToken,
        phoneNumberId: config.whatsapp.phoneNumberId,
        apiVersion: config.whatsapp.apiVersion,
      })
    : new MockWhatsAppClient();

// Mock mode has no WhatsApp to report delivery and read receipts, so pretend they arrive a few seconds later.
if (client instanceof MockWhatsAppClient) {
  client.onSent = (wamid) => {
    setTimeout(() => store.applyStatusUpdate(wamid, 'delivered', null, Date.now()), 1500 + Math.random() * 2000);
    if (Math.random() < 0.7) setTimeout(() => store.applyStatusUpdate(wamid, 'read', null, Date.now()), 4000 + Math.random() * 5000);
  };
}

const media = new MediaLibrary(store, client, config.mediaDir);

const scheduler = new Scheduler({
  store,
  client,
  media,
  ratePerSecond: config.sendRatePerSecond,
  intervalMs: config.schedulerIntervalMs,
});

const server = createApp({ config, store, client, media }).listen(config.port, () => {
  console.log(`WhatsApp Lists running on http://localhost:${config.port} (${config.mode} mode)`);
  if (config.mode === 'mock') console.log('Mock mode: nothing is sent to WhatsApp. Use the Simulator tab to try it out.');
  if (!config.admin.password) console.warn('ADMIN_PASSWORD is not set: the dashboard is open to anyone who can reach it.');
  if (!config.whatsapp.appSecret) console.warn('WHATSAPP_APP_SECRET is not set: webhook signatures are not verified.');
});
scheduler.start();

async function shutdown(signal: string) {
  console.log(`${signal} received, shutting down…`);
  server.close();
  await scheduler.stop();
  store.db.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
