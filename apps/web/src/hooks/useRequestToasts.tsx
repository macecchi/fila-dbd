import { useEffect, useRef } from 'react';
import { t } from '../i18n';
import type { Request } from '../types';
import { createToastDigest, onTabChange, type DigestView, type ToastDigest } from '../utils/toastDigest';

export const REQUESTS_TOAST_ID = 'new-requests';

export interface Arrival {
  request: Request;
  /** Skipped as a non-request (`hideNonRequests`), rather than queued. */
  ignored: boolean;
  /** 1-based place in the queue when it arrived. */
  position?: number;
}

export interface ToastActions {
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

/** "3 novos pedidos de Huntress, Slasher e Lich": the count, and each character once. */
function requestsSentence(requests: readonly Arrival[]): string {
  const count = requests.length;
  // Unidentified requests have no character to name; they still count.
  const characters = requests.map((a) => a.request).filter((r) => r.character && r.type !== 'unknown').map((r) => r.character);
  return characters.length > 0
    ? t('toast.newRequestsOf', { count, names: joinNames(characters) })
    : t('toast.newRequests', { count });
}

/** "2 mensagens sem pedidos de Ana e Beto": the count, and each sender once. */
function ignoredSentence(ignored: readonly Arrival[]): string {
  return t('toast.ignoredFrom', { count: ignored.length, names: joinNames(ignored.map((a) => a.request.donor)) });
}

function singleRequestView({ request: req, position }: Arrival): DigestView {
  const title = req.source === 'manual' ? t('toast.newRequest') :
    req.source === 'donation' ? t('toast.newRequestDonation') :
      req.source === 'resub' ? t('toast.newRequestResub') : t('toast.newRequestChat');
  const titleWithPos = position !== undefined ? `${title} (#${String(position).padStart(2, '0')})` : title;
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
 * arrival keeps the look it always had; more become a two-sentence summary: the new
 * requests with their characters as the title, the skipped messages with their senders
 * as the description (or as the title, if that's all there is). Every view sets
 * `description` and `action` explicitly: sonner merges an update into the toast it
 * replaces, so a field left out would keep its old value.
 */
export function renderArrivals(items: readonly Arrival[], release: () => void, actions: ToastActions): DigestView {
  if (items.length === 1) {
    return items[0].ignored ? singleIgnoredView(items[0], release, actions) : singleRequestView(items[0]);
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
    return { title: ignoredSentence(ignored), options: { description: undefined, action } };
  }
  return {
    title: requestsSentence(requests),
    options: { description: ignored.length > 0 ? ignoredSentence(ignored) : undefined, action },
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
  /** The room these requests belong to. */
  channel: string,
) {
  /** The room whose queue is the baseline, and the ids already accounted for in it. */
  const seen = useRef<{ channel: string; ids: Set<number> } | null>(null);
  const digest = useRef<ToastDigest<Arrival> | null>(null);
  // Toast actions run long after the render that created them.
  const latest = useRef({ update, openReview });
  useEffect(() => {
    latest.current = { update, openReview };
  });

  useEffect(() => {
    const arrivals = createToastDigest<Arrival>(REQUESTS_TOAST_ID, (items, release) => renderArrivals(items, release, {
      undo: (req) => latest.current.update(req.id, { type: 'unknown', character: '' }),
      review: () => latest.current.openReview(),
    }));
    digest.current = arrivals;
    const stopWatching = onTabChange((onTab) => arrivals.setOnTab(onTab));
    return () => {
      stopWatching();
      arrivals.dismiss();
      digest.current = null;
    };
  }, []);

  useEffect(() => {
    // What's in the queue when the first sync lands was there before this page was:
    // only what arrives after it is news. The server applies `sync-full` to the
    // requests store before it flags the room synced, so this sees the full queue.
    // (Keying this off the first non-empty batch instead swallowed the first request
    // into an empty queue, and the summary came out one short.) The same holds for each
    // room: ChannelApp stays mounted across a channel switch (e.g. from someone's queue
    // to "My queue"), and the new room's whole queue is not news either.
    if (seen.current?.channel !== channel) {
      if (seen.current) {
        digest.current?.dismiss();
        seen.current = null;
      }
      if (!synced) return;
      seen.current = { channel, ids: new Set(requests.map(r => r.id)) };
      return;
    }
    const shown = seen.current.ids;
    // `!r.done`: a later sync-full (after a reconnect) can bring in requests another
    // window already finished while this one was away — those aren't news.
    const ready = requests.filter(r => !shown.has(r.id) && !r.needsIdentification && !r.done);
    for (const req of ready) {
      shown.add(req.id);
      if (readOnly) continue;
      if (hideNonRequests && req.type === 'none') {
        digest.current?.add({ request: req, ignored: true });
        continue;
      }
      const activeRequests = requests.filter(r => !r.done && (!hideNonRequests || r.type !== 'none'));
      const index = activeRequests.findIndex(r => r.id === req.id);
      digest.current?.add({ request: req, ignored: false, position: index !== -1 ? index + 1 : undefined });
    }
  }, [requests, hideNonRequests, readOnly, synced, channel]);
}
