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

export interface Member extends Subscriber {
  status: 'active' | 'unsubscribed';
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
  receivedAt: number;
}

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
  sendAt: number;
}

const LIST_COLUMNS = `l.id, l.name, l.slug, l.description, l.welcome_message AS welcomeMessage, l.created_at AS createdAt`;
const SUBSCRIBER_COLUMNS = `s.id, s.wa_id AS waId, s.name, s.last_inbound_at AS lastInboundAt, s.created_at AS createdAt`;
const MESSAGE_COLUMNS = `m.id, m.list_id AS listId, m.kind, m.template_name AS templateName,
  m.template_language AS templateLanguage, m.template_params AS templateParams, m.body,
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
        `SELECT ${SUBSCRIBER_COLUMNS}, ms.status, ms.opted_in_at AS optedInAt, ms.unsubscribed_at AS unsubscribedAt
         FROM memberships ms JOIN subscribers s ON s.id = ms.subscriber_id
         WHERE ms.list_id = ? ORDER BY ms.status ASC, ms.opted_in_at DESC`,
      )
      .all(listId) as unknown as Member[];
  }

  /** Returns false if the subscriber was already an active member. */
  subscribe(listId: number, subscriberId: number, now: number): boolean {
    const existing = this.db
      .prepare(`SELECT status FROM memberships WHERE list_id = ? AND subscriber_id = ?`)
      .get(listId, subscriberId) as { status: string } | undefined;
    if (existing?.status === 'active') return false;
    this.db
      .prepare(
        `INSERT INTO memberships (list_id, subscriber_id, status, opted_in_at) VALUES (?, ?, 'active', ?)
         ON CONFLICT (list_id, subscriber_id) DO UPDATE SET
           status = 'active', opted_in_at = excluded.opted_in_at, unsubscribed_at = NULL`,
      )
      .run(listId, subscriberId, now);
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
        `INSERT INTO messages (list_id, kind, template_name, template_language, template_params, body, send_at, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'scheduled', ?)`,
      )
      .run(
        input.listId,
        input.kind,
        input.templateName ?? null,
        input.templateLanguage ?? null,
        JSON.stringify(input.templateParams ?? []),
        input.body ?? null,
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
        `SELECT i.id, i.wamid, i.wa_id AS waId, COALESCE(s.name, '') AS name, i.type, i.text, i.received_at AS receivedAt
         FROM inbound_messages i LEFT JOIN subscribers s ON s.wa_id = i.wa_id
         ORDER BY i.received_at DESC, i.id DESC LIMIT ?`,
      )
      .all(limit) as unknown as InboundMessage[];
  }
}
