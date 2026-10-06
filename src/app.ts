import { fileURLToPath } from 'node:url';
import express, { type Express } from 'express';
import { apiRouter } from './api.js';
import { basicAuth } from './auth.js';
import type { Config } from './config.js';
import type { MediaLibrary } from './media.js';
import type { Store } from './store.js';
import { webhookRouter } from './webhook.js';
import type { WhatsAppClient } from './whatsapp/client.js';

export interface AppDeps {
  config: Config;
  store: Store;
  client: WhatsAppClient;
  media: MediaLibrary;
  now?: () => number;
}

const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));

export function createApp({ config, store, client, media, now }: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');

  // Public: WhatsApp calls this. Requests are authenticated by their signature instead.
  app.use(
    '/webhook',
    webhookRouter({
      store,
      client,
      media,
      now,
      verifyToken: config.whatsapp.verifyToken,
      appSecret: config.whatsapp.appSecret,
    }),
  );

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });

  // Everything else is the dashboard and needs the admin login.
  app.use(basicAuth(config.admin.user, config.admin.password));
  app.use(
    '/api',
    express.json({ limit: '1mb' }),
    apiRouter({ store, client, media, now, mode: config.mode, businessPhone: config.businessPhone }),
  );
  app.use(express.static(PUBLIC_DIR));

  return app;
}
