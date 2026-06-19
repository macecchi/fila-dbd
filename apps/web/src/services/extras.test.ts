import { describe, it, expect } from 'vitest';
import { eligibleExtras } from './extras';
import { DEFAULT_EXTRAS_CONFIG } from '@filadbd/shared';

const enabledBuild = { build: { enabled: true, price: 10 } };

describe('eligibleExtras', () => {
  it('returns ["build"] when amount >= configured build price and enabled', () => {
    expect(eligibleExtras(10, enabledBuild)).toEqual(['build']);
    expect(eligibleExtras(100, enabledBuild)).toEqual(['build']);
  });
  it('returns [] when amount is below the build price', () => {
    expect(eligibleExtras(5, enabledBuild)).toEqual([]);
    expect(eligibleExtras(9.99, enabledBuild)).toEqual([]);
  });
  it('returns [] for DEFAULT_EXTRAS_CONFIG (build is opt-in, disabled by default)', () => {
    expect(eligibleExtras(100, DEFAULT_EXTRAS_CONFIG)).toEqual([]);
  });
  it('returns [] when build extra is disabled', () => {
    expect(eligibleExtras(100, { build: { enabled: false, price: 10 } })).toEqual([]);
  });
  it('returns [] when extrasConfig is missing the build key', () => {
    expect(eligibleExtras(100, {})).toEqual([]);
  });
  it('returns [] when extrasConfig is undefined', () => {
    expect(eligibleExtras(100, undefined)).toEqual([]);
  });
});
