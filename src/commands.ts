/** What a subscriber asked for in a message they sent to the business number. */
export type Command =
  | { type: 'join'; slug: string }
  | { type: 'leave'; slug: string }
  | { type: 'leave_all' }
  | { type: 'my_lists' }
  | { type: 'help' }
  | { type: 'unknown' };

const JOIN_WORDS = new Set(['JOIN', 'SUBSCRIBE', 'START']);
const LEAVE_WORDS = new Set(['STOP', 'LEAVE', 'UNSUBSCRIBE', 'QUIT', 'CANCEL', 'END']);
const LIST_WORDS = new Set(['LISTS', 'MYLISTS', 'STATUS']);
const HELP_WORDS = new Set(['HELP', 'INFO', 'MENU', '?']);

/** List keywords: lowercase letters, digits and hyphens, e.g. "prayer-group". */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function parseCommand(text: string): Command {
  const words = text.trim().replace(/\s+/g, ' ').split(' ').filter(Boolean);
  if (words.length === 0) return { type: 'unknown' };

  const first = words[0].toUpperCase().replace(/[^A-Z?]/g, '');
  const rest = words.slice(1).join('-').toLowerCase().replace(/[^a-z0-9-]/g, '');

  if (JOIN_WORDS.has(first)) return { type: 'join', slug: rest };
  if (LEAVE_WORDS.has(first)) return rest ? { type: 'leave', slug: rest } : { type: 'leave_all' };
  if (LIST_WORDS.has(first) || (first === 'MY' && rest === 'lists')) return { type: 'my_lists' };
  if (HELP_WORDS.has(first)) return { type: 'help' };
  return { type: 'unknown' };
}

export function joinKeyword(slug: string): string {
  return `JOIN ${slug}`;
}

export function joinLink(businessPhone: string, slug: string): string {
  return `https://wa.me/${businessPhone}?text=${encodeURIComponent(joinKeyword(slug))}`;
}
