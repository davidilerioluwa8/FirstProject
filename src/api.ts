import { Router, type Request, type Response } from 'express';
import QRCode from 'qrcode';
import { SLUG_PATTERN, joinKeyword, joinLink } from './commands.js';
import { handleWebhookPayload } from './inbound.js';
import type { NewList, NewMessage, Store } from './store.js';
import { MockWhatsAppClient, type WhatsAppClient } from './whatsapp/client.js';

export interface ApiOptions {
  store: Store;
  client: WhatsAppClient;
  businessPhone: string;
  mode: 'mock' | 'cloud';
  now?: () => number;
}

class BadRequest extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

function str(value: unknown, field: string, { required = false, max = 1000 } = {}): string {
  if (value === undefined || value === null || value === '') {
    if (required) throw new BadRequest(`${field} is required`);
    return '';
  }
  if (typeof value !== 'string') throw new BadRequest(`${field} must be a string`);
  const trimmed = value.trim();
  if (required && !trimmed) throw new BadRequest(`${field} is required`);
  if (trimmed.length > max) throw new BadRequest(`${field} must be at most ${max} characters`);
  return trimmed;
}

function id(req: Request, param = 'id'): number {
  const n = Number(req.params[param]);
  if (!Number.isInteger(n) || n <= 0) throw new BadRequest(`Invalid ${param}`, 404);
  return n;
}

function parseListInput(body: Record<string, unknown>, partial: boolean): Partial<NewList> {
  const out: Partial<NewList> = {};
  if (!partial || body.name !== undefined) out.name = str(body.name, 'name', { required: true, max: 100 });
  if (!partial || body.slug !== undefined) {
    const slug = str(body.slug, 'slug', { required: true, max: 40 }).toLowerCase();
    if (!SLUG_PATTERN.test(slug)) {
      throw new BadRequest('slug may only contain lowercase letters, numbers and single hyphens (e.g. "prayer-group")');
    }
    out.slug = slug;
  }
  if (body.description !== undefined) out.description = str(body.description, 'description', { max: 500 });
  if (body.welcomeMessage !== undefined) out.welcomeMessage = str(body.welcomeMessage, 'welcomeMessage', { max: 1000 });
  return out;
}

function parseMessageInput(body: Record<string, unknown>, store: Store, now: number): NewMessage {
  const listId = Number(body.listId);
  if (!Number.isInteger(listId) || !store.getList(listId)) throw new BadRequest('listId must be an existing list');

  let sendAt = now;
  if (body.sendAt !== undefined && body.sendAt !== null && body.sendAt !== '') {
    sendAt = typeof body.sendAt === 'number' ? body.sendAt : Date.parse(String(body.sendAt));
    if (!Number.isFinite(sendAt)) throw new BadRequest('sendAt must be an ISO date/time or epoch milliseconds');
    sendAt = Math.max(sendAt, now);
  }

  if (body.kind === 'text') {
    return { listId, kind: 'text', body: str(body.body, 'body', { required: true, max: 4096 }), sendAt };
  }
  if (body.kind !== 'template') throw new BadRequest('kind must be "template" or "text"');

  const templateName = str(body.templateName, 'templateName', { required: true, max: 512 });
  if (!/^[a-z0-9_]+$/.test(templateName)) {
    throw new BadRequest('templateName must match the template name in WhatsApp Manager (lowercase, digits, underscores)');
  }
  const templateLanguage = str(body.templateLanguage, 'templateLanguage', { max: 10 }) || 'en_US';
  if (!/^[a-z]{2,3}(_[A-Z]{2})?$/.test(templateLanguage)) {
    throw new BadRequest('templateLanguage must be a WhatsApp language code like en_US, en or pt_BR');
  }
  const rawParams = body.templateParams ?? [];
  if (!Array.isArray(rawParams)) throw new BadRequest('templateParams must be an array of strings');
  const templateParams = rawParams.map((p, i) => {
    const value = str(p, `templateParams[${i}]`, { required: true, max: 1024 });
    // WhatsApp rejects body parameters containing newlines, tabs or more than 4 consecutive spaces.
    if (/[\n\t]| {5,}/.test(value)) {
      throw new BadRequest(`Parameter {{${i + 1}}} can't contain line breaks, tabs or more than 4 spaces in a row`);
    }
    return value;
  });
  return { listId, kind: 'template', templateName, templateLanguage, templateParams, sendAt };
}

export function apiRouter(options: ApiOptions): Router {
  const { store, client, businessPhone, mode } = options;
  const now = options.now ?? Date.now;
  const router = Router();

  const handle =
    (fn: (req: Request, res: Response) => unknown | Promise<unknown>) => async (req: Request, res: Response) => {
      try {
        const result = await fn(req, res);
        if (!res.headersSent) res.json(result ?? { ok: true });
      } catch (err) {
        if (err instanceof BadRequest) {
          res.status(err.status).json({ error: err.message });
        } else if (String((err as Error).message).includes('UNIQUE constraint failed: lists.slug')) {
          res.status(409).json({ error: 'Another list already uses that keyword' });
        } else {
          console.error(err);
          res.status(500).json({ error: 'Internal error' });
        }
      }
    };

  const requireList = (listId: number) => {
    const list = store.getList(listId);
    if (!list) throw new BadRequest('List not found', 404);
    return list;
  };

  router.get('/config', handle(() => ({ mode, businessPhone })));

  // ─── Lists ────────────────────────────────────────────────────────────────

  router.get('/lists', handle(() => store.listLists()));

  router.post(
    '/lists',
    handle((req, res) => {
      res.status(201);
      return store.createList(parseListInput(req.body ?? {}, false) as NewList, now());
    }),
  );

  router.patch(
    '/lists/:id',
    handle((req) => {
      const listId = id(req);
      requireList(listId);
      return store.updateList(listId, parseListInput(req.body ?? {}, true));
    }),
  );

  router.delete(
    '/lists/:id',
    handle((req) => {
      if (!store.deleteList(id(req))) throw new BadRequest('List not found', 404);
    }),
  );

  router.get(
    '/lists/:id/join',
    handle(async (req) => {
      const list = requireList(id(req));
      const link = joinLink(businessPhone, list.slug);
      return { keyword: joinKeyword(list.slug), link, qr: await QRCode.toDataURL(link, { margin: 1, width: 320 }) };
    }),
  );

  router.get('/lists/:id/members', handle((req) => store.listMembers(requireList(id(req)).id)));

  router.delete(
    '/lists/:id/members/:subscriberId',
    handle((req) => {
      const list = requireList(id(req));
      if (!store.unsubscribe(list.id, id(req, 'subscriberId'), now())) throw new BadRequest('Not an active member', 404);
    }),
  );

  // ─── Messages ─────────────────────────────────────────────────────────────

  router.get('/messages', handle(() => store.listMessages()));

  router.post(
    '/messages',
    handle((req, res) => {
      res.status(201);
      return store.createMessage(parseMessageInput(req.body ?? {}, store, now()), now());
    }),
  );

  router.post(
    '/messages/:id/cancel',
    handle((req) => {
      if (!store.cancelMessage(id(req))) throw new BadRequest('Only scheduled messages that have not started can be cancelled', 409);
    }),
  );

  router.get('/messages/:id/deliveries', handle((req) => store.listDeliveries(id(req))));

  // ─── Inbox ────────────────────────────────────────────────────────────────

  router.get('/inbox', handle(() => store.listInbound()));

  // ─── Simulator (mock mode only) ───────────────────────────────────────────

  if (client instanceof MockWhatsAppClient) {
    let counter = 0;
    router.post(
      '/simulate/inbound',
      handle(async (req) => {
        const body = req.body ?? {};
        const from = str(body.from, 'from', { required: true, max: 20 }).replace(/\D/g, '');
        if (from.length < 7) throw new BadRequest('from must be a phone number in international format');
        const text = str(body.text, 'text', { required: true, max: 4096 });
        await handleWebhookPayload(
          {
            object: 'whatsapp_business_account',
            entry: [
              {
                changes: [
                  {
                    field: 'messages',
                    value: {
                      contacts: [{ wa_id: from, profile: { name: str(body.name, 'name', { max: 100 }) } }],
                      messages: [{ id: `wamid.sim-${Date.now()}-${++counter}`, from, type: 'text', text: { body: text } }],
                    },
                  },
                ],
              },
            ],
          },
          { store, client, now },
        );
      }),
    );

    router.get('/simulate/outbox', handle(() => client.outbox));
  }

  return router;
}
