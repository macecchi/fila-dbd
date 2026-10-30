import type { RequestExtraType, RoomExtras } from './types';

export const MAX_DONATION_REQUESTS = 10;

/** How many requests a donation pays for: one per `minDonation`, capped. */
export function computeEntitlement(amountVal: number, minDonation: number): number {
  if (!minDonation || minDonation <= 0) return 1;
  const n = Math.floor(amountVal / minDonation);
  if (n < 1) return 1;
  return Math.min(MAX_DONATION_REQUESTS, n);
}

/**
 * Returns the list of extra types whose per-room price is met by `amount`.
 * Order doesn't matter; the LLM prompt just needs to know which extras to look for.
 */
export function eligibleExtras(amount: number, config: RoomExtras | undefined): RequestExtraType[] {
  if (!config) return [];
  const out: RequestExtraType[] = [];
  if (config.build?.enabled && amount >= config.build.price) out.push('build');
  return out;
}

// LivePix relays only the first 250 characters of a donor message to chat, so a
// request may live in the lost tail. Callers keep such donates visible for manual
// review instead of hiding them.
export const LIVEPIX_TRUNCATION_LENGTH = 250;

export function isLikelyTruncatedDonation(message: string): boolean {
  return message.length >= LIVEPIX_TRUNCATION_LENGTH;
}

/**
 * The id of the `index`-th request split out of request `id` (a donation paying for
 * several). Deterministic, so a retried identification lands on the same rows.
 */
export function splitRequestId(id: number, index: number): number {
  const source = `${id}:${index}`;
  let hash = 0;
  for (let i = 0; i < source.length; i++) {
    hash = ((hash << 5) - hash) + source.charCodeAt(i);
    hash = hash & hash;
  }
  return Math.abs(hash);
}
