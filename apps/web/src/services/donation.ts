import type { Request, RequestExtra } from '../types';

export { MAX_DONATION_REQUESTS, computeEntitlement } from '@filadbd/shared';

interface BuildInput {
  donor: string;
  amount: string;
  amountVal: number;
  message: string;
  twitchMsgId: string | undefined;
  timestampMs: number;
  identified: Array<{
    character: string;
    type: 'survivor' | 'killer' | 'unknown' | 'none' | string;
    matchedTerm?: string;
    extras?: RequestExtra[];
  }>;
}

function hashToInt(source: string): number {
  let hash = 0;
  for (let i = 0; i < source.length; i++) {
    const char = source.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash);
}

function makeId(twitchMsgId: string | undefined, fallback: string, index: number): number {
  // No time-prefix here: at minute-precision * 1e9 the magnitude (~2.8e19) is past
  // Number.MAX_SAFE_INTEGER and small hash differences (e.g. ":0" vs ":1") get rounded
  // to the same float, producing colliding IDs. Hash alone gives 31 bits of uniqueness
  // across the small set of segments, and the `position` column drives ordering.
  const source = twitchMsgId ? `${twitchMsgId}:${index}` : `${fallback}:${index}`;
  return hashToInt(source);
}

export function buildDonationRequests(input: BuildInput): Request[] {
  const { donor, amount, amountVal, message, twitchMsgId, timestampMs, identified } = input;
  const originMsgId = twitchMsgId ?? `synthetic:${donor}:${amount}:${timestampMs}`;
  const timestamp = new Date(timestampMs);

  if (identified.length === 0) {
    const fallback = `donation:${donor}:${amount}:${message}`;
    return [{
      id: makeId(twitchMsgId, fallback, 0),
      timestamp,
      donor,
      amount,
      amountVal,
      message,
      character: 'Identificando...',
      type: 'unknown',
      source: 'donation',
      needsIdentification: true,
      originMsgId,
    }];
  }

  return identified.map((c, i) => {
    const fallback = `donation:${donor}:${amount}:${message}:${i}`;
    return {
      id: makeId(twitchMsgId, fallback, i),
      timestamp,
      donor,
      amount,
      amountVal,
      message,
      character: c.character || '',
      type: (c.type as Request['type']) || 'unknown',
      source: 'donation',
      needsIdentification: false,
      matchedTerm: c.matchedTerm,
      originMsgId,
      extras: c.extras,
    };
  });
}
