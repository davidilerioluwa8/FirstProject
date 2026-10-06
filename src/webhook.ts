import { createHmac, timingSafeEqual } from 'node:crypto';
import express, { Router } from 'express';
import { handleWebhookPayload, type InboundDeps, type WebhookPayload } from './inbound.js';

export interface WebhookOptions extends InboundDeps {
  verifyToken: string;
  /** Meta app secret. When empty (mock mode), signatures are not checked. */
  appSecret: string;
}

export function isValidSignature(rawBody: Buffer, header: string | undefined, appSecret: string): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  const given = Buffer.from(header.slice('sha256='.length), 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function webhookRouter(options: WebhookOptions): Router {
  const router = Router();

  // Meta calls this once when you register the webhook URL.
  router.get('/', (req, res) => {
    const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
    if (mode === 'subscribe' && options.verifyToken && token === options.verifyToken) {
      res.status(200).type('text/plain').send(String(challenge ?? ''));
    } else {
      res.sendStatus(403);
    }
  });

  router.post('/', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (options.appSecret && !isValidSignature(raw, req.get('x-hub-signature-256'), options.appSecret)) {
      res.sendStatus(401);
      return;
    }

    let payload: WebhookPayload;
    try {
      payload = JSON.parse(raw.toString('utf8'));
    } catch {
      res.sendStatus(400);
      return;
    }

    try {
      await handleWebhookPayload(payload, options);
      res.sendStatus(200);
    } catch (err) {
      // A non-200 makes Meta retry; inbound messages are de-duplicated by id, so that's safe.
      (options.log ?? console.error)(`Webhook processing failed: ${(err as Error).stack ?? err}`);
      res.sendStatus(500);
    }
  });

  return router;
}
