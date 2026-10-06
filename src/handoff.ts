import type { Handoff, NotifyStatus, Store, Subscriber } from './store.js';
import type { WhatsAppClient } from './whatsapp/client.js';

const WINDOW_MS = 24 * 60 * 60 * 1000;
/** A second "talk to me" within this time reuses the open request instead of alerting the owner again. */
export const HANDOFF_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/** Template parameters can't contain line breaks or long runs of spaces. */
function oneLine(text: string, max = 300): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return (flat.length > max ? `${flat.slice(0, max - 1)}…` : flat) || '(no message)';
}

export interface HandoffResult {
  handoff: Handoff;
  /** False when this repeated a recent open request, so the owner wasn't alerted again. */
  isNew: boolean;
}

/**
 * Records that someone asked to talk to a person and alerts the owner on their own WhatsApp.
 * Free text reaches the owner only if they messaged the business number in the last 24h;
 * otherwise the approved notification template from Settings is used.
 */
export async function requestHandoff(
  subscriber: Subscriber,
  text: string,
  deps: { store: Store; client: WhatsAppClient },
  now: number,
): Promise<HandoffResult> {
  const { store, client } = deps;
  const existing = store.openHandoffFor(subscriber.id);
  if (existing && now - existing.createdAt < HANDOFF_COOLDOWN_MS) return { handoff: existing, isNew: false };

  const settings = store.getSettings();
  const who = subscriber.name || 'Someone';
  let notifyStatus: NotifyStatus = 'not_configured';
  let notifyError: string | null = 'Add your personal WhatsApp number in Settings to get call-back alerts';

  if (settings.ownerPhone) {
    try {
      const owner = store.getSubscriberByWaId(settings.ownerPhone);
      if (owner?.lastInboundAt && now - owner.lastInboundAt <= WINDOW_MS) {
        await client.sendText(
          settings.ownerPhone,
          `📞 *Call-back request*\n\n*${who}* (+${subscriber.waId}) wants to speak with you.\nThey sent: "${oneLine(text)}"\n\nChat or call them: https://wa.me/${subscriber.waId}`,
        );
      } else if (settings.notifyTemplateName) {
        await client.sendTemplate(settings.ownerPhone, {
          name: settings.notifyTemplateName,
          language: settings.notifyTemplateLanguage || 'en_US',
          bodyParams: [oneLine(who, 60), `+${subscriber.waId}`, oneLine(text)],
        });
      } else {
        throw new Error(
          "You haven't messaged the business number in the last 24 hours, and no notification template is set in Settings",
        );
      }
      notifyStatus = 'sent';
      notifyError = null;
    } catch (err) {
      notifyStatus = 'failed';
      notifyError = (err as Error).message;
    }
  }

  return {
    handoff: store.createHandoff({ subscriberId: subscriber.id, message: text, notifyStatus, notifyError }, now),
    isNew: true,
  };
}
