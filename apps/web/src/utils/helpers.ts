import type { ReactNode } from 'react';
import { createElement } from 'react';
import { getLocale } from '../i18n';

const rtfCache: Record<string, Intl.RelativeTimeFormat> = {};
function getRtf(): Intl.RelativeTimeFormat {
  const locale = getLocale();
  if (!rtfCache[locale]) rtfCache[locale] = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  return rtfCache[locale];
}

export function formatRelativeTime(date: Date): string {
  const rtf = getRtf();
  const diff = (date.getTime() - Date.now()) / 1000;
  if (Math.abs(diff) < 60) return rtf.format(Math.round(diff), 'second');
  if (Math.abs(diff) < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (Math.abs(diff) < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  return rtf.format(Math.round(diff / 86400), 'day');
}

export function parseAmount(str: string): number {
  const m = str.match(/[\d,\.]+/);
  return m ? parseFloat(m[0].replace(',', '.')) : 0;
}

export const DONATE_BOT_NAMES = new Set(['livepix', 'streamelements']);

export function isDonateBot(username: string): boolean {
  return DONATE_BOT_NAMES.has(username.toLowerCase());
}

export interface ParsedDonationMessage {
  donor: string;
  amount: string;
  message: string;
}

// Reset every scroll container to the top. On desktop the window/document is the
// scroller; on mobile (≤480px) the body is the scroll container (html is
// overflow:hidden, body is overflow:auto/height:100dvh), so window.scrollTo alone
// is a no-op there — reset the element scrollTops too.
export function scrollToTop() {
  window.scrollTo(0, 0);
  document.documentElement.scrollTop = 0;
  document.body.scrollTop = 0;
}

export function navigate(path: string) {
  if (path === window.location.pathname) return;
  window.history.pushState(null, '', path);
  scrollToTop();
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function handleLinkClick(e: React.MouseEvent<HTMLAnchorElement>) {
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
  e.preventDefault();
  navigate(e.currentTarget.getAttribute('href')!);
}

/**
 * Wraps each occurrence of any term in `<mark className="matched-term">…</mark>`.
 *
 * - Terms are resolved by longest-first, case-insensitive, against the original
 *   message. Each character of the message is "claimed" by at most one term —
 *   shorter terms that overlap an already-claimed span are dropped.
 * - The first match of each term is highlighted; subsequent occurrences are
 *   left as plain text (matches existing single-term behavior).
 * - Empty `terms` returns the message as a single text node.
 */
export function highlightTerms(message: string, terms: string[]): ReactNode[] {
  if (terms.length === 0) return [message];

  const candidates = terms
    .filter(Boolean)
    .map(t => {
      const start = message.toLowerCase().indexOf(t.toLowerCase());
      return start >= 0 ? { start, end: start + t.length, text: message.slice(start, start + t.length) } : null;
    })
    .filter((c): c is { start: number; end: number; text: string } => c !== null)
    .sort((a, b) => (b.end - b.start) - (a.end - a.start) || a.start - b.start);

  const kept: { start: number; end: number; text: string }[] = [];
  for (const c of candidates) {
    const overlaps = kept.some(k => c.start < k.end && c.end > k.start);
    if (!overlaps) kept.push(c);
  }
  kept.sort((a, b) => a.start - b.start);

  if (kept.length === 0) return [message];

  // If the kept matches cover the entire (trimmed) message contiguously, the
  // highlight adds no information — return the message plain. This kills the
  // pointless "wrap the whole string" mark on manual requests (and on any
  // donation where the donor literally just wrote the character name).
  const trimStart = message.length - message.trimStart().length;
  const trimEnd = message.trimEnd().length;
  const coversAll =
    kept[0].start <= trimStart &&
    kept[kept.length - 1].end >= trimEnd &&
    kept.every((k, i) => i === 0 || k.start === kept[i - 1].end);
  if (coversAll) return [message];

  const out: ReactNode[] = [];
  let cursor = 0;
  kept.forEach((k, i) => {
    if (cursor < k.start) out.push(message.slice(cursor, k.start));
    out.push(createElement('mark', { key: `m-${i}`, className: 'matched-term' }, k.text));
    cursor = k.end;
  });
  if (cursor < message.length) out.push(message.slice(cursor));
  return out;
}

// LivePix relays at most 250 chars of the donor's message to Twitch chat and cuts
// mid-word with no ellipsis (verified against production chat logs — every long
// donate lands at exactly 250). The full text only exists in the streamer's
// LivePix feed, so when the character request sits in the lost tail the LLM sees
// nothing and would classify the donate as "no request". Callers use this to keep
// such donates visible for manual review instead of hiding them.
export const LIVEPIX_TRUNCATION_LENGTH = 250;

export function isLikelyTruncatedDonation(message: string): boolean {
  return message.length >= LIVEPIX_TRUNCATION_LENGTH;
}

export function parseDonationMessage(message: string): ParsedDonationMessage | null {
  const match = message.match(/^(.+?)\s+(?:doou|mandou|just tipped)\s+((?:R\$|\$)?\s?[\d,.]+)(?:\s*:\s*|\s+e disse:\s*|\s*-\s*)(.+)$/i);
  if (!match) return null;
  return {
    donor: match[1].trim(),
    amount: match[2].trim(),
    message: match[3].trim()
  };
}
