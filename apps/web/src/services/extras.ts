import type { RequestExtraType, RoomExtras } from '@filadbd/shared';

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
