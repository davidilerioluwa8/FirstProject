import express, { Router, type Request, type Response } from 'express';
import QRCode from 'qrcode';
import { RESERVED_WORDS, SLUG_PATTERN, joinKeyword, joinLink } from './commands.js';
import { handleWebhookPayload } from './inbound.js';
import { MAX_UPLOAD_BYTES, type MediaLibrary, MediaError } from './media.js';
import { normalizePhone } from './phone.js';
import { type NewAutoReply, type NewList, type NewMessage, type Settings, type Store, normalizeKeyword } from './store.js';
import { MockWhatsAppClient, type WhatsAppClient } from './whatsapp/client.js';

export interface ApiOptions {
  store: Store;
  client: WhatsAppClient;
  media: MediaLibrary;
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

function parseMediaId(value: unknown, store: Store): number | null {
  if (value === undefined || value === null || value === '') return null;
  const mediaId = Number(value);
  if (!Number.isInteger(mediaId) || !store.getMedia(mediaId)) throw new BadRequest('mediaId must be an uploaded file');
  return mediaId;
}

function parseMessageInput(body: Record<string, unknown>, store: Store, now: number): NewMessage {
  const listId = Number(body.listId);
  if (!Number.isInteger(listId) || !store.getList(listId)) throw new BadRequest('listId must be an existing list');
  const mediaId = parseMediaId(body.mediaId, store);

  let sendAt = now;
  if (body.sendAt !== undefined && body.sendAt !== null && body.sendAt !== '') {
    sendAt = typeof body.sendAt === 'number' ? body.sendAt : Date.parse(String(body.sendAt));
    if (!Number.isFinite(sendAt)) throw new BadRequest('sendAt must be an ISO date/time or epoch milliseconds');
    sendAt = Math.max(sendAt, now);
  }

  if (body.kind === 'text') {
    return { listId, kind: 'text', body: str(body.body, 'body', { required: !mediaId, max: 4096 }), mediaId, sendAt };
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
  return { listId, kind: 'template', templateName, templateLanguage, templateParams, mediaId, sendAt };
}

function parseAutoReplyInput(body: Record<string, unknown>, store: Store, partial: boolean): Partial<NewAutoReply> {
  const out: Partial<NewAutoReply> = {};
  if (!partial || body.keyword !== undefined) {
    const keyword = normalizeKeyword(str(body.keyword, 'keyword', { required: true, max: 30 }));
    if (!keyword) throw new BadRequest('Keywords need at least one letter or number, e.g. ACCOUNT or PRICE LIST');
    if (RESERVED_WORDS.has(keyword.split(' ')[0])) {
      throw new BadRequest(`"${keyword.split(' ')[0]}" is already used for joining, leaving or help. Pick another keyword.`);
    }
    out.keyword = keyword;
  }
  if (!partial || body.action !== undefined) {
    if (body.action !== 'reply' && body.action !== 'handoff') throw new BadRequest('action must be "reply" or "handoff"');
    out.action = body.action;
  }
  if (body.replyText !== undefined) out.replyText = str(body.replyText, 'replyText', { max: 4096 });
  if (body.mediaId !== undefined) out.mediaId = parseMediaId(body.mediaId, store);
  if (body.enabled !== undefined) out.enabled = Boolean(body.enabled);
  return out;
}

function parseSettingsInput(body: Record<string, unknown>, current: Settings): Partial<Settings> {
  const out: Partial<Settings> = {};
  if (body.ownerPhone !== undefined) {
    const raw = str(body.ownerPhone, 'ownerPhone', { max: 30 });
    if (raw) {
      // Without a leading 0 the number is taken to include its country code.
      const cc = typeof body.defaultCountryCode === 'string' ? body.defaultCountryCode : current.defaultCountryCode;
      const phone = normalizePhone(raw.startsWith('0') ? raw : `+${raw.replace(/^\+/, '')}`, cc);
      if (!phone) throw new BadRequest('Enter your number with the country code, e.g. +234 803 123 4567');
      out.ownerPhone = phone;
    } else {
      out.ownerPhone = '';
    }
  }
  if (body.ownerName !== undefined) out.ownerName = str(body.ownerName, 'ownerName', { max: 60 });
  if (body.notifyTemplateName !== undefined) {
    const name = str(body.notifyTemplateName, 'notifyTemplateName', { max: 512 });
    if (name && !/^[a-z0-9_]+$/.test(name)) throw new BadRequest('Template names use lowercase letters, digits and underscores');
    out.notifyTemplateName = name;
  }
  if (body.notifyTemplateLanguage !== undefined) {
    out.notifyTemplateLanguage = str(body.notifyTemplateLanguage, 'notifyTemplateLanguage', { max: 10 }) || 'en_US';
  }
  if (body.defaultCountryCode !== undefined) {
    const cc = str(body.defaultCountryCode, 'defaultCountryCode', { max: 5 }).replace(/\D/g, '');
    if (cc.length > 3) throw new BadRequest('Country codes are 1–3 digits, e.g. 234 for Nigeria or 44 for the UK');
    out.defaultCountryCode = cc;
  }
  return out;
}

export function apiRouter(options: ApiOptions): Router {
  const { store, client, media, businessPhone, mode } = options;
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
        } else if (err instanceof MediaError) {
          res.status(400).json({ error: err.message });
        } else if (String((err as Error).message).includes('UNIQUE constraint failed: lists.slug')) {
          res.status(409).json({ error: 'Another list already uses that keyword' });
        } else if (String((err as Error).message).includes('UNIQUE constraint failed: auto_replies.keyword')) {
          res.status(409).json({ error: 'You already have an auto-reply for that keyword' });
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

  // Add people you already have permission to message (e.g. existing customers).
  router.post(
    '/lists/:id/members',
    handle((req) => {
      const list = requireList(id(req));
      const body = req.body ?? {};
      if (body.consent !== true) {
        throw new BadRequest('Confirm that these people agreed to receive WhatsApp messages from you');
      }
      if (!Array.isArray(body.contacts) || body.contacts.length === 0) throw new BadRequest('Add at least one contact');
      if (body.contacts.length > 5000) throw new BadRequest('Add at most 5,000 contacts at a time');
      const { defaultCountryCode } = store.getSettings();
      const result = { added: 0, alreadyMember: 0, optedOut: [] as string[], invalid: [] as string[] };
      for (const contact of body.contacts as { phone?: unknown; name?: unknown }[]) {
        const raw = typeof contact?.phone === 'string' ? contact.phone : '';
        const waId = normalizePhone(raw, defaultCountryCode);
        if (!waId) {
          result.invalid.push(raw || '(blank)');
          continue;
        }
        const name = typeof contact.name === 'string' ? contact.name.trim().slice(0, 100) : '';
        const outcome = store.addContact(list.id, waId, name, now());
        if (outcome === 'added') result.added++;
        else if (outcome === 'already_member') result.alreadyMember++;
        else result.optedOut.push(`+${waId}`);
      }
      return result;
    }),
  );

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

  // ─── Inbox & call-back requests ───────────────────────────────────────────

  router.get('/inbox', handle(() => store.listInbound()));

  router.get('/handoffs', handle(() => store.listHandoffs()));

  router.post(
    '/handoffs/:id/done',
    handle((req) => {
      if (!store.resolveHandoff(id(req), now())) throw new BadRequest('Request not found or already done', 404);
    }),
  );

  // ─── Auto-replies ─────────────────────────────────────────────────────────

  router.get('/auto-replies', handle(() => store.listAutoReplies()));

  router.post(
    '/auto-replies',
    handle((req, res) => {
      const input = parseAutoReplyInput(req.body ?? {}, store, false) as NewAutoReply;
      if (input.action === 'reply' && !input.replyText && !input.mediaId) {
        throw new BadRequest('Add the reply text or attach a file');
      }
      res.status(201);
      return store.createAutoReply(input, now());
    }),
  );

  router.patch(
    '/auto-replies/:id',
    handle((req) => {
      const updated = store.updateAutoReply(id(req), parseAutoReplyInput(req.body ?? {}, store, true));
      if (!updated) throw new BadRequest('Auto-reply not found', 404);
      return updated;
    }),
  );

  router.delete(
    '/auto-replies/:id',
    handle((req) => {
      if (!store.deleteAutoReply(id(req))) throw new BadRequest('Auto-reply not found', 404);
    }),
  );

  // ─── Files ────────────────────────────────────────────────────────────────

  router.get('/media', handle(() => store.listMedia().map(({ storagePath: _, ...m }) => m)));

  router.post(
    '/media',
    express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES }),
    handle(async (req, res) => {
      const filename = str(req.query.filename, 'filename', { required: true, max: 255 });
      const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const { storagePath: _, ...saved } = await media.save(data, filename, req.get('content-type'), now());
      res.status(201);
      return saved;
    }),
  );

  router.get(
    '/media/:id/file',
    handle(async (req, res) => {
      const file = store.getMedia(id(req));
      if (!file) throw new BadRequest('File not found', 404);
      res
        .type(file.mimeType)
        .set('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(file.filename)}`)
        .set('X-Content-Type-Options', 'nosniff')
        .send(await media.read(file));
    }),
  );

  router.delete(
    '/media/:id',
    handle(async (req) => {
      const result = await media.remove(id(req));
      if (result === 'missing') throw new BadRequest('File not found', 404);
      if (result === 'in_use') throw new BadRequest('This file is attached to an auto-reply or an unsent message', 409);
    }),
  );

  // ─── Settings & stats ─────────────────────────────────────────────────────

  router.get('/settings', handle(() => store.getSettings()));

  router.put('/settings', handle((req) => store.updateSettings(parseSettingsInput(req.body ?? {}, store.getSettings()))));

  router.get(
    '/stats',
    handle((req) => {
      const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
      const tz = Number(req.query.tzOffset);
      const tzOffset = Number.isFinite(tz) && Math.abs(tz) <= 14 * 60 ? tz : 0;
      return store.stats(now(), days, tzOffset);
    }),
  );

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
          { store, client, media, now },
        );
      }),
    );

    router.get('/simulate/outbox', handle(() => client.outbox));
  }

  return router;
}
