import { useEffect, useRef } from 'react';
import { t } from '../i18n';
import type { Request } from '../types';
import { createToastDigest, onTabChange, type DigestView, type ToastDigest } from '../utils/toastDigest';

/** A request that joined the queue (at its 1-based `position`), or one skipped as a non-request. */
type Arrival =
  | { request: Request; ignored: false; position: number }
  | { request: Request; ignored: true };

interface ToastActions {
  /** Puts a skipped message back in the queue. */
  undo: (req: Request) => void;
  /** Opens the review dialog, which lists skipped messages and can restore them. */
  review: () => void;
}

const truncate = (text: string, max: number) => (text.length > max ? text.slice(0, max) + '…' : text);

/**
 * Names in arrival order, each once: "Ana", "Ana e Beto", "Ana, Beto e Caio", and past
 * three "Ana, Beto e mais 2". Used for senders and for characters alike.
 */
export function joinNames(names: readonly string[]): string {
  const seen = new Set<string>();
  const unique = names.filter((name) => {
    const key = name.toLowerCase(); // Twitch names are case-insensitive
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const [a = '', b = '', c = ''] = unique;
  if (unique.length <= 1) return a;
  if (unique.length === 2) return t('toast.namesTwo', { a, b });
  if (unique.length === 3) return t('toast.namesThree', { a, b, c });
  return t('toast.namesMore', { a, b, count: unique.length - 2 });
}

/**
 * "Huntress, Slasher e Lich": each character once, under a title that already has the
 * count. Unidentified requests count but have nothing to name.
 */
function requestNames(requests: readonly Arrival[]): string | null {
  const characters = requests.map((a) => a.request).filter((r) => r.character && r.type !== 'unknown').map((r) => r.character);
  return characters.length > 0 ? joinNames(characters) : null;
}

/** Each sender of a skipped message once. */
const senderNames = (ignored: readonly Arrival[]) => joinNames(ignored.map((a) => a.request.donor));

function singleRequestView({ request: req, position }: Extract<Arrival, { ignored: false }>): DigestView {
  const title = req.source === 'manual' ? t('toast.newRequest') :
    req.source === 'donation' ? t('toast.newRequestDonation') :
      req.source === 'resub' ? t('toast.newRequestResub') : t('toast.newRequestChat');
  const titleWithPos = `${title} (#${String(position).padStart(2, '0')})`;
  const message = req.character
    ? (req.amount ? t('toast.requestedCharAmount', { donor: req.donor, character: req.character, amount: req.amount }) : t('toast.requestedChar', { donor: req.donor, character: req.character }))
    : (req.amount ? t('toast.newRequestFromAmount', { donor: req.donor, amount: req.amount }) : t('toast.newRequestFrom', { donor: req.donor }));
  return { title: titleWithPos, options: { description: message, action: undefined } };
}

function singleIgnoredView({ request: req }: Arrival, release: () => void, actions: ToastActions): DigestView {
  return {
    title: t('toast.ignored', { donor: req.donor, message: truncate(req.message, 50) }),
    options: {
      description: undefined,
      action: { label: t('toast.undo'), onClick: () => { release(); actions.undo(req); } },
    },
  };
}

/**
 * Everything that arrived since the streamer last saw the toast, in one toast. A single
 * arrival keeps the look it always had; more become a summary: the count in the title,
 * the names in a one-line description, never the count twice.
 *   "4 novos pedidos" / "Huntress, Trapper e Lich · 3 mensagens sem pedidos de Rafa e Beto"
 *   "2 mensagens sem pedidos" / "De Beto e Duda"
 * Every view sets `description` and `action` explicitly: sonner merges an update into the
 * toast it replaces, so a field left out would keep its old value.
 */
function renderArrivals(items: readonly Arrival[], release: () => void, actions: ToastActions): DigestView {
  if (items.length === 1) {
    const [only] = items;
    return only.ignored ? singleIgnoredView(only, release, actions) : singleRequestView(only);
  }
  const requests = items.filter((a) => !a.ignored);
  const ignored = items.filter((a) => a.ignored);
  // sonner allows one action, and one Undo can't cover several arrivals. The review
  // dialog lists skipped messages and restores them, so it's offered whenever the
  // summary includes some; requests need no action.
  const action = ignored.length > 0
    ? { label: t('toast.review'), onClick: () => { release(); actions.review(); } }
    : undefined;

  // Skipped messages had already qualified (a donation at or above the minimum, a
  // resub, an eligible chat command), so the streamer wants to know whose they were.
  if (requests.length === 0) {
    return {
      title: t('toast.ignoredCount', { count: ignored.length }),
      options: { description: t('toast.ignoredFromNames', { names: senderNames(ignored) }), action },
    };
  }
  const details = [
    requestNames(requests),
    ignored.length > 0 ? t('toast.ignoredFrom', { count: ignored.length, names: senderNames(ignored) }) : null,
  ].filter((part) => part !== null);
  return {
    title: t('toast.newRequests', { count: requests.length }),
    options: { description: details.length > 0 ? details.join(' · ') : undefined, action },
  };
}

/**
 * Toasts for what arrives while the page is open: one toast, updated in place with a
 * count, instead of one per request or skipped message. It waits for the streamer (who
 * is usually in a match with the game focused) and leaves a few seconds after they're
 * back on the tab — see `createToastDigest`.
 */
export function useRequestToasts(
  requests: Request[],
  update: (id: number, updates: Partial<Request>) => void,
  hideNonRequests: boolean,
  readOnly: boolean,
  openReview: () => void,
  /** The first `sync-full` has landed (`partySynced`). */
  synced: boolean,
) {
  /** Ids already accounted for, from the queue as of the first sync on. */
  const seen = useRef<Set<number> | null>(null);
  const digest = useRef<ToastDigest<Arrival> | null>(null);

  // `update` and `openReview` are stable for the life of a room (the channel view is
  // keyed by channel), so this runs once per room and its cleanup drops the room's toast.
  useEffect(() => {
    const arrivals = createToastDigest<Arrival>('new-requests', (items, release) => renderArrivals(items, release, {
      undo: (req) => update(req.id, { type: 'unknown', character: '' }),
      review: openReview,
    }));
    digest.current = arrivals;
    const stopWatching = onTabChange((onTab) => arrivals.setOnTab(onTab));
    return () => {
      stopWatching();
      arrivals.dismiss();
      digest.current = null;
    };
  }, [update, openReview]);

  useEffect(() => {
    // What's in the queue when the first sync lands was there before this page was: only
    // what arrives after it is news. `sync-full` reaches the requests store before the
    // room is flagged synced, so this sees the full queue.
    if (!seen.current) {
      if (synced) seen.current = new Set(requests.map(r => r.id));
      return;
    }
    const shown = seen.current;
    // `!r.done`: a later sync-full (after a reconnect) can bring in requests another
    // window finished meanwhile — not news.
    const ready = requests.filter(r => !shown.has(r.id) && !r.needsIdentification && !r.done);
    if (ready.length === 0) return;
    for (const req of ready) shown.add(req.id);
    if (readOnly) return;
    const queue = requests.filter(r => !r.done && (!hideNonRequests || r.type !== 'none'));
    digest.current?.add(...ready.map((req): Arrival => hideNonRequests && req.type === 'none'
      ? { request: req, ignored: true }
      : { request: req, ignored: false, position: queue.indexOf(req) + 1 }));
  }, [requests, hideNonRequests, readOnly, synced]);
}
