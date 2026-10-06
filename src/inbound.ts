import { parseCommand } from './commands.js';
import type { DeliveryStatus, Store, Subscriber } from './store.js';
import type { WhatsAppClient } from './whatsapp/client.js';

/** The parts of a WhatsApp Cloud API webhook payload we use. */
export interface WebhookPayload {
  object?: string;
  entry?: {
    changes?: {
      field?: string;
      value?: {
        contacts?: { wa_id: string; profile?: { name?: string } }[];
        messages?: InboundWhatsAppMessage[];
        statuses?: {
          id: string;
          status: string;
          recipient_id?: string;
          errors?: { code?: number; title?: string; message?: string; error_data?: { details?: string } }[];
        }[];
      };
    }[];
  }[];
}

export interface InboundWhatsAppMessage {
  id: string;
  from: string;
  timestamp?: string;
  type: string;
  text?: { body?: string };
  button?: { text?: string; payload?: string };
  interactive?: { button_reply?: { id?: string; title?: string }; list_reply?: { id?: string; title?: string } };
}

export interface InboundDeps {
  store: Store;
  client: WhatsAppClient;
  now?: () => number;
  log?: (line: string) => void;
}

const STATUS_MAP: Record<string, DeliveryStatus> = {
  sent: 'sent',
  delivered: 'delivered',
  read: 'read',
  failed: 'failed',
};

/** Text of a message, including taps on template quick-reply buttons (e.g. "Stop promotions"). */
export function messageText(msg: InboundWhatsAppMessage): string {
  switch (msg.type) {
    case 'text':
      return msg.text?.body ?? '';
    case 'button':
      return msg.button?.text || msg.button?.payload || '';
    case 'interactive':
      return msg.interactive?.button_reply?.title ?? msg.interactive?.list_reply?.title ?? '';
    default:
      return '';
  }
}

export async function handleWebhookPayload(payload: WebhookPayload, deps: InboundDeps): Promise<void> {
  const now = deps.now ?? Date.now;
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== 'messages' || !change.value) continue;
      const { contacts = [], messages = [], statuses = [] } = change.value;
      const names = new Map(contacts.map((c) => [c.wa_id, c.profile?.name ?? '']));

      for (const msg of messages) {
        await handleInboundMessage(msg, names.get(msg.from) ?? '', deps);
      }
      for (const st of statuses) {
        const status = STATUS_MAP[st.status];
        if (!status) continue;
        const err = st.errors?.[0];
        const error = err ? [err.code, err.title ?? err.message, err.error_data?.details].filter(Boolean).join(' — ') : null;
        deps.store.applyStatusUpdate(st.id, status, error, now());
      }
    }
  }
}

export async function handleInboundMessage(
  msg: InboundWhatsAppMessage,
  profileName: string,
  deps: InboundDeps,
): Promise<void> {
  const { store } = deps;
  const now = (deps.now ?? Date.now)();
  const text = messageText(msg);

  if (!store.recordInbound({ wamid: msg.id, waId: msg.from, type: msg.type, text }, now)) return; // duplicate webhook

  const subscriber = store.touchSubscriber(msg.from, profileName, now);
  const reply = replyFor(text, subscriber, store, now);
  if (!reply) return;

  try {
    await deps.client.sendText(msg.from, reply);
  } catch (err) {
    (deps.log ?? console.error)(`Failed to reply to ${msg.from}: ${(err as Error).message}`);
  }
}

/** Applies the subscriber's command and returns the reply to send, or null to stay quiet. */
function replyFor(text: string, subscriber: Subscriber, store: Store, now: number): string | null {
  const command = parseCommand(text);

  switch (command.type) {
    case 'join': {
      if (!command.slug) return 'Please send *JOIN* followed by the list name, for example: JOIN newsletter';
      const list = store.getListBySlug(command.slug);
      if (!list) {
        return `Sorry, I couldn't find a list called "${command.slug}". Please check the link or keyword you were given.`;
      }
      if (!store.subscribe(list.id, subscriber.id, now)) {
        return `You're already on *${list.name}*. Reply *STOP ${list.slug}* to leave.`;
      }
      const welcome = list.welcomeMessage.trim() || `You've joined *${list.name}*. 🎉`;
      return `${welcome}\n\nReply *STOP ${list.slug}* to leave this list, or *STOP* to leave all lists.`;
    }

    case 'leave': {
      const list = store.getListBySlug(command.slug);
      // An unrecognised list name (e.g. a "Stop promotions" button) is treated as "leave everything".
      if (!list) return leaveAll(subscriber, store, now);
      if (!store.unsubscribe(list.id, subscriber.id, now)) return `You're not on *${list.name}*.`;
      return `You've left *${list.name}*. Reply *JOIN ${list.slug}* any time to rejoin.`;
    }

    case 'leave_all':
      return leaveAll(subscriber, store, now);

    case 'my_lists': {
      const lists = store.activeListsFor(subscriber.id);
      if (lists.length === 0) return "You're not on any lists right now.";
      return `You're on:\n${lists.map((l) => `• *${l.name}* (${l.slug})`).join('\n')}\n\nReply *STOP <list>* to leave one.`;
    }

    case 'help':
      return helpText();

    case 'unknown':
      // Members replying to a broadcast ("thanks!") land in the dashboard inbox without an auto-reply.
      return store.activeListsFor(subscriber.id).length > 0 ? null : helpText();
  }
}

function leaveAll(subscriber: Subscriber, store: Store, now: number): string {
  store.unsubscribeAll(subscriber.id, now);
  return "You've been unsubscribed from all lists and won't receive any more broadcasts. Reply *JOIN <list>* to rejoin.";
}

function helpText(): string {
  return [
    'Here’s what you can send:',
    '• *JOIN <list>* – join a list',
    '• *STOP <list>* – leave a list',
    '• *STOP* – leave all lists',
    '• *LISTS* – see the lists you’re on',
  ].join('\n');
}
