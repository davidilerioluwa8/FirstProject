import type { Database } from './db.js';
import { transaction } from './db.js';

export interface List {
  id: number;
  name: string;
  slug: string;
  description: string;
  welcomeMessage: string;
  createdAt: number;
}

export interface ListWithCounts extends List {
  activeCount: number;
  unsubscribedCount: number;
}

export interface Subscriber {
  id: number;
  waId: string;
  name: string;
  lastInboundAt: number | null;
  createdAt: number;
}

export type MembershipSource = 'whatsapp' | 'manual';

export interface Member extends Subscriber {
  status: 'active' | 'unsubscribed';
  source: MembershipSource;
  optedInAt: number;
  unsubscribedAt: number | null;
}

export type MessageKind = 'template' | 'text';
export type MessageStatus = 'scheduled' | 'sending' | 'sent' | 'cancelled' | 'failed';

export interface Message {
  id: number;
  listId: number;
  kind: MessageKind;
  templateName: string | null;
  templateLanguage: string | null;
  templateParams: string[];
  body: string | null;
  mediaId: number | null;
  sendAt: number;
  status: MessageStatus;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export type DeliveryStatus = 'pending' | 'accepted' | 'sent' | 'delivered' | 'read' | 'failed' | 'skipped';

export type DeliveryCounts = Record<DeliveryStatus, number> & { total: number };

export interface MessageSummary extends Message {
  listName: string;
  counts: DeliveryCounts;
}

export interface Delivery {
  id: number;
  messageId: number;
  subscriberId: number;
  waId: string;
  name: string;
  wamid: string | null;
  status: DeliveryStatus;
  error: string | null;
  updatedAt: number;
}

export interface PendingDelivery {
  deliveryId: number;
  subscriber: Subscriber;
}

export interface InboundMessage {
  id: number;
  wamid: string;
  waId: string;
  name: string;
  type: string;
  text: string;
  handledAs: string;
  receivedAt: number;
}

export type MediaKind = 'image' | 'video' | 'document';

export interface Media {
  id: number;
  filename: string;
  mimeType: string;
  size: number;
  kind: MediaKind;
  storagePath: string;
  waMediaId: string | null;
  waUploadedAt: number | null;
  createdAt: number;
}

export interface MediaWithUsage extends Media {
  usedBy: number;
}

export type AutoReplyAction = 'reply' | 'handoff';

export interface AutoReply {
  id: number;
  keyword: string;
  action: AutoReplyAction;
  replyText: string;
  mediaId: number | null;
  enabled: boolean;
  hitCount: number;
  lastHitAt: number | null;
  createdAt: number;
}

export interface NewAutoReply {
  keyword: string;
  action: AutoReplyAction;
  replyText?: string;
  mediaId?: number | null;
  enabled?: boolean;
}

export type NotifyStatus = 'sent' | 'failed' | 'not_configured';

export interface Handoff {
  id: number;
  subscriberId: number;
  waId: string;
  name: string;
  message: string;
  status: 'open' | 'done';
  notifyStatus: NotifyStatus;
  notifyError: string | null;
  createdAt: number;
  resolvedAt: number | null;
}

export interface Settings {
  /** Where call-back requests are forwarded (digits only). */
  ownerPhone: string;
  ownerName: string;
  /** Approved template used to notify the owner when they haven't messaged the business number in 24h. */
  notifyTemplateName: string;
  notifyTemplateLanguage: string;
  /** Used for local numbers starting with 0 when adding contacts by hand, e.g. "234". */
  defaultCountryCode: string;
}

const DEFAULT_SETTINGS: Settings = {
  ownerPhone: '',
  ownerName: '',
  notifyTemplateName: '',
  notifyTemplateLanguage: 'en_US',
  defaultCountryCode: '',
};

export type AddContactResult = 'added' | 'already_member' | 'opted_out';

export interface CampaignStats {
  id: number;
  listName: string;
  kind: MessageKind;
  label: string;
  sendAt: number;
  status: MessageStatus;
  recipients: number;
  sent: number;
  delivered: number;
  read: number;
  failed: number;
  skipped: number;
  replied: number;
}

export interface Stats {
  days: number;
  totals: {
    activeSubscribers: number;
    joined: number;
    left: number;
    campaigns: number;
    recipients: number;
    sent: number;
    delivered: number;
    read: number;
    failed: number;
    replied: number;
  };
  daily: { date: string; joined: number; left: number }[];
  campaigns: CampaignStats[];
  autoReplies: Pick<AutoReply, 'id' | 'keyword' | 'action' | 'hitCount' | 'lastHitAt'>[];
}

/** People who message back within this long after a campaign count as replies to it. */
export const REPLY_WINDOW_MS = 72 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface NewList {
  name: string;
  slug: string;
  description?: string;
  welcomeMessage?: string;
}

export interface NewMessage {
  listId: number;
  kind: MessageKind;
  templateName?: string | null;
  templateLanguage?: string | null;
  templateParams?: string[];
  body?: string | null;
  mediaId?: number | null;
  sendAt: number;
}

const LIST_COLUMNS = `l.id, l.name, l.slug, l.description, l.welcome_message AS welcomeMessage, l.created_at AS createdAt`;
const MEDIA_COLUMNS = `md.id, md.filename, md.mime_type AS mimeType, md.size, md.kind, md.storage_path AS storagePath,
  md.wa_media_id AS waMediaId, md.wa_uploaded_at AS waUploadedAt, md.created_at AS createdAt`;
const AUTO_REPLY_COLUMNS = `a.id, a.keyword, a.action, a.reply_text AS replyText, a.media_id AS mediaId, a.enabled,
  a.hit_count AS hitCount, a.last_hit_at AS lastHitAt, a.created_at AS createdAt`;
const SUBSCRIBER_COLUMNS = `s.id, s.wa_id AS waId, s.name, s.last_inbound_at AS lastInboundAt, s.created_at AS createdAt`;
const MESSAGE_COLUMNS = `m.id, m.list_id AS listId, m.kind, m.template_name AS templateName,
  m.template_language AS templateLanguage, m.template_params AS templateParams, m.body, m.media_id AS mediaId,
  m.send_at AS sendAt, m.status, m.created_at AS createdAt, m.started_at AS startedAt, m.finished_at AS finishedAt`;

/** Delivery statuses only move forward (WhatsApp may report "read" before "delivered"). */
const STATUS_RANK: Record<DeliveryStatus, number> = {
  pending: 0,
  accepted: 1,
  sent: 2,
  delivered: 3,
  read: 4,
  skipped: 5,
  failed: 5,
};

function emptyCounts(): DeliveryCounts {
  return { total: 0, pending: 0, accepted: 0, sent: 0, delivered: 0, read: 0, failed: 0, skipped: 0 };
}

type Row = Record<string, unknown>;

function toAutoReply(row: Row): AutoReply {
  return { ...(row as unknown as AutoReply), enabled: Boolean(row.enabled) };
}

/**
 * Normalises a keyword or incoming text for matching: uppercase, punctuation as spaces, single spaces.
 * "Call me, please!" becomes "CALL ME PLEASE", which starts with the keyword "CALL ME".
 */
export function normalizeKeyword(text: string): string {
  return text
    .toUpperCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function toMessage(row: Row): Message {
  return { ...(row as unknown as Message), templateParams: JSON.parse(String(row.templateParams)) };
}

export class Store {
  constructor(readonly db: Database) {}

  // ─── Lists ────────────────────────────────────────────────────────────────

  listLists(): ListWithCounts[] {
    return this.db
      .prepare(
        `SELECT ${LIST_COLUMNS},
           COALESCE(SUM(ms.status = 'active'), 0) AS activeCount,
           COALESCE(SUM(ms.status = 'unsubscribed'), 0) AS unsubscribedCount
         FROM lists l LEFT JOIN memberships ms ON ms.list_id = l.id
         GROUP BY l.id ORDER BY l.created_at DESC, l.id DESC`,
      )
      .all() as unknown as ListWithCounts[];
  }

  getList(id: number): List | undefined {
    return this.db.prepare(`SELECT ${LIST_COLUMNS} FROM lists l WHERE l.id = ?`).get(id) as List | undefined;
  }

  getListBySlug(slug: string): List | undefined {
    return this.db
      .prepare(`SELECT ${LIST_COLUMNS} FROM lists l WHERE l.slug = ?`)
      .get(slug.toLowerCase()) as List | undefined;
  }

  createList(input: NewList, now: number): List {
    const result = this.db
      .prepare(`INSERT INTO lists (name, slug, description, welcome_message, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(input.name, input.slug.toLowerCase(), input.description ?? '', input.welcomeMessage ?? '', now);
    return this.getList(Number(result.lastInsertRowid))!;
  }

  updateList(id: number, patch: Partial<NewList>): List | undefined {
    const current = this.getList(id);
    if (!current) return undefined;
    const next = { ...current, ...patch };
    this.db
      .prepare(`UPDATE lists SET name = ?, slug = ?, description = ?, welcome_message = ? WHERE id = ?`)
      .run(next.name, next.slug.toLowerCase(), next.description, next.welcomeMessage, id);
    return this.getList(id);
  }

  deleteList(id: number): boolean {
    return this.db.prepare(`DELETE FROM lists WHERE id = ?`).run(id).changes > 0;
  }

  // ─── Subscribers & memberships ────────────────────────────────────────────

  getSubscriber(id: number): Subscriber | undefined {
    return this.db.prepare(`SELECT ${SUBSCRIBER_COLUMNS} FROM subscribers s WHERE s.id = ?`).get(id) as
      | Subscriber
      | undefined;
  }

  getSubscriberByWaId(waId: string): Subscriber | undefined {
    return this.db.prepare(`SELECT ${SUBSCRIBER_COLUMNS} FROM subscribers s WHERE s.wa_id = ?`).get(waId) as
      | Subscriber
      | undefined;
  }

  /** Creates the subscriber if needed and records that they just messaged us. */
  touchSubscriber(waId: string, name: string, now: number): Subscriber {
    this.db
      .prepare(
        `INSERT INTO subscribers (wa_id, name, last_inbound_at, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (wa_id) DO UPDATE SET
           last_inbound_at = excluded.last_inbound_at,
           name = CASE WHEN excluded.name <> '' THEN excluded.name ELSE subscribers.name END`,
      )
      .run(waId, name, now, now);
    return this.db.prepare(`SELECT ${SUBSCRIBER_COLUMNS} FROM subscribers s WHERE s.wa_id = ?`).get(waId) as unknown as Subscriber;
  }

  listMembers(listId: number): Member[] {
    return this.db
      .prepare(
        `SELECT ${SUBSCRIBER_COLUMNS}, ms.status, ms.source, ms.opted_in_at AS optedInAt, ms.unsubscribed_at AS unsubscribedAt
         FROM memberships ms JOIN subscribers s ON s.id = ms.subscriber_id
         WHERE ms.list_id = ? ORDER BY ms.status ASC, ms.opted_in_at DESC`,
      )
      .all(listId) as unknown as Member[];
  }

  /** Returns false if the subscriber was already an active member. */
  subscribe(listId: number, subscriberId: number, now: number, source: MembershipSource = 'whatsapp'): boolean {
    const existing = this.db
      .prepare(`SELECT status FROM memberships WHERE list_id = ? AND subscriber_id = ?`)
      .get(listId, subscriberId) as { status: string } | undefined;
    if (existing?.status === 'active') return false;
    this.db
      .prepare(
        `INSERT INTO memberships (list_id, subscriber_id, status, opted_in_at, source) VALUES (?, ?, 'active', ?, ?)
         ON CONFLICT (list_id, subscriber_id) DO UPDATE SET
           status = 'active', opted_in_at = excluded.opted_in_at, unsubscribed_at = NULL, source = excluded.source`,
      )
      .run(listId, subscriberId, now, source);
    return true;
  }

  /** Returns false if the subscriber was not an active member. */
  unsubscribe(listId: number, subscriberId: number, now: number): boolean {
    return (
      this.db
        .prepare(
          `UPDATE memberships SET status = 'unsubscribed', unsubscribed_at = ?
           WHERE list_id = ? AND subscriber_id = ? AND status = 'active'`,
        )
        .run(now, listId, subscriberId).changes > 0
    );
  }

  /**
   * Adds someone you already have permission to message. Never re-adds a person who left the
   * list themselves: they said STOP, and only they can rejoin.
   */
  addContact(listId: number, waId: string, name: string, now: number): AddContactResult {
    return transaction(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO subscribers (wa_id, name, created_at) VALUES (?, ?, ?)
           ON CONFLICT (wa_id) DO UPDATE SET name = CASE WHEN subscribers.name = '' THEN excluded.name ELSE subscribers.name END`,
        )
        .run(waId, name, now);
      const sub = this.db.prepare(`SELECT id FROM subscribers WHERE wa_id = ?`).get(waId) as { id: number };
      const existing = this.db
        .prepare(`SELECT status FROM memberships WHERE list_id = ? AND subscriber_id = ?`)
        .get(listId, sub.id) as { status: string } | undefined;
      if (existing?.status === 'active') return 'already_member';
      if (existing?.status === 'unsubscribed') return 'opted_out';
      this.subscribe(listId, sub.id, now, 'manual');
      return 'added';
    });
  }

  unsubscribeAll(subscriberId: number, now: number): number {
    return Number(
      this.db
        .prepare(
          `UPDATE memberships SET status = 'unsubscribed', unsubscribed_at = ?
           WHERE subscriber_id = ? AND status = 'active'`,
        )
        .run(now, subscriberId).changes,
    );
  }

  activeListsFor(subscriberId: number): List[] {
    return this.db
      .prepare(
        `SELECT ${LIST_COLUMNS} FROM lists l JOIN memberships ms ON ms.list_id = l.id
         WHERE ms.subscriber_id = ? AND ms.status = 'active' ORDER BY l.name`,
      )
      .all(subscriberId) as unknown as List[];
  }

  // ─── Messages ─────────────────────────────────────────────────────────────

  createMessage(input: NewMessage, now: number): Message {
    const result = this.db
      .prepare(
        `INSERT INTO messages (list_id, kind, template_name, template_language, template_params, body, media_id, send_at, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?)`,
      )
      .run(
        input.listId,
        input.kind,
        input.templateName ?? null,
        input.templateLanguage ?? null,
        JSON.stringify(input.templateParams ?? []),
        input.body ?? null,
        input.mediaId ?? null,
        input.sendAt,
        now,
      );
    return this.getMessage(Number(result.lastInsertRowid))!;
  }

  getMessage(id: number): Message | undefined {
    const row = this.db.prepare(`SELECT ${MESSAGE_COLUMNS} FROM messages m WHERE m.id = ?`).get(id) as Row | undefined;
    return row && toMessage(row);
  }

  listMessages(): MessageSummary[] {
    const rows = this.db
      .prepare(
        `SELECT ${MESSAGE_COLUMNS}, l.name AS listName FROM messages m JOIN lists l ON l.id = m.list_id
         ORDER BY m.send_at DESC, m.id DESC`,
      )
      .all() as Row[];
    const counts = this.db
      .prepare(`SELECT message_id AS messageId, status, COUNT(*) AS n FROM deliveries GROUP BY message_id, status`)
      .all() as { messageId: number; status: DeliveryStatus; n: number }[];
    const byMessage = new Map<number, DeliveryCounts>();
    for (const { messageId, status, n } of counts) {
      const c = byMessage.get(messageId) ?? emptyCounts();
      c[status] += n;
      c.total += n;
      byMessage.set(messageId, c);
    }
    return rows.map((row) => ({
      ...toMessage(row),
      listName: String(row.listName),
      counts: byMessage.get(Number(row.id)) ?? emptyCounts(),
    }));
  }

  /** Only messages that haven't started sending can be cancelled. */
  cancelMessage(id: number): boolean {
    return (
      this.db.prepare(`UPDATE messages SET status = 'cancelled' WHERE id = ? AND status = 'scheduled'`).run(id)
        .changes > 0
    );
  }

  /** Messages whose time has come, plus any left half-sent by a crash or restart. */
  dueMessages(now: number): Message[] {
    return (
      this.db
        .prepare(
          `SELECT ${MESSAGE_COLUMNS} FROM messages m
           WHERE (m.status = 'scheduled' AND m.send_at <= ?) OR m.status = 'sending'
           ORDER BY m.send_at, m.id`,
        )
        .all(now) as Row[]
    ).map(toMessage);
  }

  /**
   * Marks the message as sending and snapshots the list's active members as
   * pending deliveries. Safe to call again when resuming.
   */
  startSending(messageId: number, now: number): void {
    transaction(this.db, () => {
      this.db
        .prepare(`UPDATE messages SET status = 'sending', started_at = COALESCE(started_at, ?) WHERE id = ?`)
        .run(now, messageId);
      this.db
        .prepare(
          `INSERT OR IGNORE INTO deliveries (message_id, subscriber_id, status, updated_at)
           SELECT m.id, ms.subscriber_id, 'pending', ?
           FROM messages m JOIN memberships ms ON ms.list_id = m.list_id AND ms.status = 'active'
           WHERE m.id = ? AND m.status = 'sending'`,
        )
        .run(now, messageId);
    });
  }

  pendingDeliveries(messageId: number): PendingDelivery[] {
    const rows = this.db
      .prepare(
        `SELECT d.id AS deliveryId, ${SUBSCRIBER_COLUMNS}
         FROM deliveries d JOIN subscribers s ON s.id = d.subscriber_id
         WHERE d.message_id = ? AND d.status = 'pending' ORDER BY d.id`,
      )
      .all(messageId) as Row[];
    return rows.map(({ deliveryId, ...subscriber }) => ({
      deliveryId: Number(deliveryId),
      subscriber: subscriber as unknown as Subscriber,
    }));
  }

  setDeliveryResult(
    deliveryId: number,
    result: { status: DeliveryStatus; wamid?: string | null; error?: string | null },
    now: number,
  ): void {
    this.db
      .prepare(`UPDATE deliveries SET status = ?, wamid = ?, error = ?, updated_at = ? WHERE id = ?`)
      .run(result.status, result.wamid ?? null, result.error ?? null, now, deliveryId);
  }

  finishMessage(messageId: number, now: number): MessageStatus {
    const counts = this.deliveryCounts(messageId);
    const status: MessageStatus = counts.total > 0 && counts.failed === counts.total ? 'failed' : 'sent';
    this.db.prepare(`UPDATE messages SET status = ?, finished_at = ? WHERE id = ?`).run(status, now, messageId);
    return status;
  }

  deliveryCounts(messageId: number): DeliveryCounts {
    const rows = this.db
      .prepare(`SELECT status, COUNT(*) AS n FROM deliveries WHERE message_id = ? GROUP BY status`)
      .all(messageId) as { status: DeliveryStatus; n: number }[];
    const counts = emptyCounts();
    for (const { status, n } of rows) {
      counts[status] = n;
      counts.total += n;
    }
    return counts;
  }

  listDeliveries(messageId: number): Delivery[] {
    return this.db
      .prepare(
        `SELECT d.id, d.message_id AS messageId, d.subscriber_id AS subscriberId, s.wa_id AS waId, s.name,
           d.wamid, d.status, d.error, d.updated_at AS updatedAt
         FROM deliveries d JOIN subscribers s ON s.id = d.subscriber_id
         WHERE d.message_id = ? ORDER BY d.id`,
      )
      .all(messageId) as unknown as Delivery[];
  }

  /** Applies a status webhook from WhatsApp. Ignores updates that would move a delivery backwards. */
  applyStatusUpdate(wamid: string, status: DeliveryStatus, error: string | null, now: number): boolean {
    const row = this.db.prepare(`SELECT id, status FROM deliveries WHERE wamid = ?`).get(wamid) as
      | { id: number; status: DeliveryStatus }
      | undefined;
    if (!row) return false;
    if (STATUS_RANK[status] <= STATUS_RANK[row.status] && status !== 'failed') return false;
    if (row.status === 'failed') return false;
    this.db
      .prepare(`UPDATE deliveries SET status = ?, error = COALESCE(?, error), updated_at = ? WHERE id = ?`)
      .run(status, error, now, row.id);
    return true;
  }

  // ─── Inbound messages ─────────────────────────────────────────────────────

  /** Returns false if this WhatsApp message id was already processed (webhooks can be retried). */
  recordInbound(input: { wamid: string; waId: string; type: string; text: string }, now: number): boolean {
    return (
      this.db
        .prepare(
          `INSERT OR IGNORE INTO inbound_messages (wamid, wa_id, type, text, received_at) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(input.wamid, input.waId, input.type, input.text, now).changes > 0
    );
  }

  listInbound(limit = 200): InboundMessage[] {
    return this.db
      .prepare(
        `SELECT i.id, i.wamid, i.wa_id AS waId, COALESCE(s.name, '') AS name, i.type, i.text, i.handled_as AS handledAs,
           i.received_at AS receivedAt
         FROM inbound_messages i LEFT JOIN subscribers s ON s.wa_id = i.wa_id
         ORDER BY i.received_at DESC, i.id DESC LIMIT ?`,
      )
      .all(limit) as unknown as InboundMessage[];
  }

  setInboundHandled(wamid: string, handledAs: string): void {
    this.db.prepare(`UPDATE inbound_messages SET handled_as = ? WHERE wamid = ?`).run(handledAs, wamid);
  }

  // ─── Media (attachments) ──────────────────────────────────────────────────

  createMedia(input: Omit<Media, 'id' | 'waMediaId' | 'waUploadedAt' | 'createdAt'>, now: number): Media {
    const result = this.db
      .prepare(`INSERT INTO media (filename, mime_type, size, kind, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(input.filename, input.mimeType, input.size, input.kind, input.storagePath, now);
    return this.getMedia(Number(result.lastInsertRowid))!;
  }

  getMedia(id: number): Media | undefined {
    return this.db.prepare(`SELECT ${MEDIA_COLUMNS} FROM media md WHERE md.id = ?`).get(id) as Media | undefined;
  }

  listMedia(): MediaWithUsage[] {
    return this.db
      .prepare(
        `SELECT ${MEDIA_COLUMNS},
           (SELECT COUNT(*) FROM auto_replies a WHERE a.media_id = md.id)
           + (SELECT COUNT(*) FROM messages m WHERE m.media_id = md.id AND m.status IN ('scheduled', 'sending')) AS usedBy
         FROM media md ORDER BY md.created_at DESC, md.id DESC`,
      )
      .all() as unknown as MediaWithUsage[];
  }

  /** Files still needed by an auto-reply or an unsent message can't be deleted. */
  deleteMedia(id: number): 'deleted' | 'in_use' | 'missing' {
    const media = this.listMedia().find((m) => m.id === id);
    if (!media) return 'missing';
    if (media.usedBy > 0) return 'in_use';
    transaction(this.db, () => {
      this.db.prepare(`UPDATE messages SET media_id = NULL WHERE media_id = ?`).run(id);
      this.db.prepare(`DELETE FROM media WHERE id = ?`).run(id);
    });
    return 'deleted';
  }

  setWhatsAppMediaId(id: number, waMediaId: string, now: number): void {
    this.db.prepare(`UPDATE media SET wa_media_id = ?, wa_uploaded_at = ? WHERE id = ?`).run(waMediaId, now, id);
  }

  // ─── Auto-replies (keyword triggers) ──────────────────────────────────────

  listAutoReplies(): AutoReply[] {
    return (this.db.prepare(`SELECT ${AUTO_REPLY_COLUMNS} FROM auto_replies a ORDER BY a.keyword`).all() as Row[]).map(
      toAutoReply,
    );
  }

  getAutoReply(id: number): AutoReply | undefined {
    const row = this.db.prepare(`SELECT ${AUTO_REPLY_COLUMNS} FROM auto_replies a WHERE a.id = ?`).get(id) as
      | Row
      | undefined;
    return row && toAutoReply(row);
  }

  /** The enabled auto-reply whose keyword is the whole message, or the start of it ("ACCOUNT please"). */
  matchAutoReply(text: string): AutoReply | undefined {
    const normalized = normalizeKeyword(text);
    if (!normalized) return undefined;
    const row = this.db
      .prepare(
        `SELECT ${AUTO_REPLY_COLUMNS} FROM auto_replies a
         WHERE a.enabled = 1 AND (a.keyword = ?1 OR substr(?1, 1, length(a.keyword) + 1) = a.keyword || ' ')
         ORDER BY length(a.keyword) DESC LIMIT 1`,
      )
      .get(normalized) as Row | undefined;
    return row && toAutoReply(row);
  }

  createAutoReply(input: NewAutoReply, now: number): AutoReply {
    const result = this.db
      .prepare(
        `INSERT INTO auto_replies (keyword, action, reply_text, media_id, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        normalizeKeyword(input.keyword),
        input.action,
        input.replyText ?? '',
        input.mediaId ?? null,
        input.enabled === false ? 0 : 1,
        now,
      );
    return this.getAutoReply(Number(result.lastInsertRowid))!;
  }

  updateAutoReply(id: number, patch: Partial<NewAutoReply>): AutoReply | undefined {
    const current = this.getAutoReply(id);
    if (!current) return undefined;
    const next = { ...current, ...patch };
    this.db
      .prepare(`UPDATE auto_replies SET keyword = ?, action = ?, reply_text = ?, media_id = ?, enabled = ? WHERE id = ?`)
      .run(normalizeKeyword(next.keyword), next.action, next.replyText, next.mediaId ?? null, next.enabled ? 1 : 0, id);
    return this.getAutoReply(id);
  }

  deleteAutoReply(id: number): boolean {
    return this.db.prepare(`DELETE FROM auto_replies WHERE id = ?`).run(id).changes > 0;
  }

  recordAutoReplyHit(id: number, now: number): void {
    this.db.prepare(`UPDATE auto_replies SET hit_count = hit_count + 1, last_hit_at = ? WHERE id = ?`).run(now, id);
  }

  // ─── Call-back requests ───────────────────────────────────────────────────

  createHandoff(
    input: { subscriberId: number; message: string; notifyStatus: NotifyStatus; notifyError?: string | null },
    now: number,
  ): Handoff {
    const result = this.db
      .prepare(
        `INSERT INTO handoffs (subscriber_id, message, status, notify_status, notify_error, created_at) VALUES (?, ?, 'open', ?, ?, ?)`,
      )
      .run(input.subscriberId, input.message, input.notifyStatus, input.notifyError ?? null, now);
    return this.listHandoffs().find((h) => h.id === Number(result.lastInsertRowid))!;
  }

  listHandoffs(): Handoff[] {
    return this.db
      .prepare(
        `SELECT h.id, h.subscriber_id AS subscriberId, s.wa_id AS waId, s.name, h.message, h.status,
           h.notify_status AS notifyStatus, h.notify_error AS notifyError, h.created_at AS createdAt, h.resolved_at AS resolvedAt
         FROM handoffs h JOIN subscribers s ON s.id = h.subscriber_id
         ORDER BY h.status = 'done', h.created_at DESC, h.id DESC LIMIT 200`,
      )
      .all() as unknown as Handoff[];
  }

  resolveHandoff(id: number, now: number): boolean {
    return (
      this.db.prepare(`UPDATE handoffs SET status = 'done', resolved_at = ? WHERE id = ? AND status = 'open'`).run(now, id)
        .changes > 0
    );
  }

  /** The newest open request from this person, so repeated "CALL ME"s don't pile up. */
  openHandoffFor(subscriberId: number): Handoff | undefined {
    return this.listHandoffs().find((h) => h.subscriberId === subscriberId && h.status === 'open');
  }

  // ─── Settings ─────────────────────────────────────────────────────────────

  getSettings(): Settings {
    const rows = this.db.prepare(`SELECT key, value FROM settings`).all() as { key: string; value: string }[];
    const settings = { ...DEFAULT_SETTINGS };
    for (const { key, value } of rows) {
      if (key in settings) settings[key as keyof Settings] = value;
    }
    return settings;
  }

  updateSettings(patch: Partial<Settings>): Settings {
    const stmt = this.db.prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    );
    transaction(this.db, () => {
      for (const [key, value] of Object.entries(patch)) {
        if (key in DEFAULT_SETTINGS && typeof value === 'string') stmt.run(key, value);
      }
    });
    return this.getSettings();
  }

  // ─── Stats ────────────────────────────────────────────────────────────────

  /**
   * Audience and campaign numbers for the last `days` days. `tzOffsetMinutes` is the viewer's
   * `Date#getTimezoneOffset()`, so daily buckets follow their local midnight.
   */
  stats(now: number, days: number, tzOffsetMinutes: number): Stats {
    const offset = tzOffsetMinutes * 60_000;
    const today = Math.floor((now - offset) / DAY_MS);
    const firstDay = today - days + 1;
    const since = firstDay * DAY_MS + offset;
    const daily = Array.from({ length: days }, (_, i) => ({
      date: new Date((firstDay + i) * DAY_MS).toISOString().slice(0, 10),
      joined: 0,
      left: 0,
    }));
    for (const [column, field] of [['opted_in_at', 'joined'], ['unsubscribed_at', 'left']] as const) {
      const rows = this.db
        .prepare(
          `SELECT CAST((${column} - ?) / ${DAY_MS} AS INTEGER) AS day, COUNT(*) AS n
           FROM memberships WHERE ${column} >= ? GROUP BY day`,
        )
        .all(offset, since) as { day: number; n: number }[];
      for (const { day, n } of rows) {
        const i = day - firstDay;
        if (i >= 0 && i < days) daily[i][field] = n;
      }
    }

    const campaigns = (
      this.db
        .prepare(
          `SELECT m.id, l.name AS listName, m.kind, m.template_name AS templateName, m.body, m.send_at AS sendAt, m.status,
             COUNT(d.id) AS recipients,
             COALESCE(SUM(d.status IN ('accepted', 'sent', 'delivered', 'read')), 0) AS sent,
             COALESCE(SUM(d.status IN ('delivered', 'read')), 0) AS delivered,
             COALESCE(SUM(d.status = 'read'), 0) AS read,
             COALESCE(SUM(d.status = 'failed'), 0) AS failed,
             COALESCE(SUM(d.status = 'skipped'), 0) AS skipped,
             COALESCE(SUM(d.status IN ('accepted', 'sent', 'delivered', 'read') AND EXISTS (
               SELECT 1 FROM inbound_messages i JOIN subscribers s ON s.wa_id = i.wa_id
               WHERE s.id = d.subscriber_id
                 AND i.received_at > COALESCE(m.started_at, m.send_at)
                 AND i.received_at < COALESCE(m.started_at, m.send_at) + ${REPLY_WINDOW_MS}
             )), 0) AS replied
           FROM messages m JOIN lists l ON l.id = m.list_id LEFT JOIN deliveries d ON d.message_id = m.id
           WHERE m.status IN ('sending', 'sent', 'failed') AND COALESCE(m.started_at, m.send_at) >= ?
           GROUP BY m.id ORDER BY m.send_at DESC`,
        )
        .all(since) as Row[]
    ).map((row) => {
      const { templateName, body, ...rest } = row;
      return {
        ...(rest as unknown as CampaignStats),
        label: row.kind === 'template' ? String(templateName) : String(body ?? '').slice(0, 80),
      };
    });

    const totals = {
      activeSubscribers: Number(
        (this.db.prepare(`SELECT COUNT(DISTINCT subscriber_id) AS n FROM memberships WHERE status = 'active'`).get() as Row).n,
      ),
      joined: daily.reduce((n, d) => n + d.joined, 0),
      left: daily.reduce((n, d) => n + d.left, 0),
      campaigns: campaigns.length,
      recipients: 0,
      sent: 0,
      delivered: 0,
      read: 0,
      failed: 0,
      replied: 0,
    };
    for (const c of campaigns) {
      totals.recipients += c.recipients;
      totals.sent += c.sent;
      totals.delivered += c.delivered;
      totals.read += c.read;
      totals.failed += c.failed;
      totals.replied += c.replied;
    }

    const autoReplies = this.listAutoReplies().map(({ id, keyword, action, hitCount, lastHitAt }) => ({
      id,
      keyword,
      action,
      hitCount,
      lastHitAt,
    }));

    return { days, totals, daily, campaigns, autoReplies };
  }
}
