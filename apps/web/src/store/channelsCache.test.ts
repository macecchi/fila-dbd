import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { loadCachedChannels, saveCachedChannels, type ActiveRoom, type RecentRoom } from './channelsCache';

const KEY = 'fila-dbd-channels-v3';

function sampleRoom(overrides: Partial<ActiveRoom> = {}): ActiveRoom {
  return {
    id: 'room1',
    channel_login: 'streamer1',
    request_count: 5,
    pending_count: 3,
    updated_at: '2026-05-23 12:00:00',
    avatar_url: 'https://example.com/avatar.png',
    banner_url: null,
    status: 'live',
    is_live: true,
    thumbnail_url: 'https://example.com/thumb.png',
    viewer_count: 100,
    ...overrides,
  };
}

function sampleRecent(overrides: Partial<RecentRoom> = {}): RecentRoom {
  return {
    id: 'room9',
    channel_login: 'streamer9',
    display_name: 'Streamer9',
    avatar_url: null,
    request_count: 42,
    updated_at: '2026-05-22 12:00:00',
    ...overrides,
  };
}

describe('channelsCache', () => {
  beforeEach(() => {
    // Bun's runtime injects a partial localStorage that shadows jsdom's (it lacks
    // .clear), so install a clean in-memory store for deterministic, isolated tests.
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => { store.set(k, String(v)); },
      removeItem: (k: string) => { store.delete(k); },
      clear: () => store.clear(),
      key: (i: number) => [...store.keys()][i] ?? null,
      get length() { return store.size; },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('round-trips rooms, recent, and total through save/load', () => {
    const rooms = [sampleRoom(), sampleRoom({ id: 'room2', channel_login: 'streamer2' })];
    const recent = [sampleRecent()];
    saveCachedChannels(rooms, recent, 42);
    expect(loadCachedChannels()).toEqual({ rooms, recent, totalChannels: 42 });
  });

  it('leaves totalChannels undefined when it was not saved', () => {
    saveCachedChannels([sampleRoom()], []);
    expect(loadCachedChannels()?.totalChannels).toBeUndefined();
  });

  it('returns null when nothing is cached', () => {
    expect(loadCachedChannels()).toBeNull();
  });

  it('returns null on corrupt JSON', () => {
    localStorage.setItem(KEY, '{not valid json');
    expect(loadCachedChannels()).toBeNull();
  });

  it('returns null when the envelope is null', () => {
    localStorage.setItem(KEY, 'null');
    expect(loadCachedChannels()).toBeNull();
  });

  it('returns null on a version mismatch', () => {
    localStorage.setItem(KEY, JSON.stringify({ v: 0, rooms: [sampleRoom()] }));
    expect(loadCachedChannels()).toBeNull();
  });

  it('returns null when rooms is not an array', () => {
    localStorage.setItem(KEY, JSON.stringify({ v: 3, rooms: 'nope' }));
    expect(loadCachedChannels()).toBeNull();
  });

  it('defaults recent to an empty array when the envelope lacks it', () => {
    localStorage.setItem(KEY, JSON.stringify({ v: 3, rooms: [sampleRoom()] }));
    expect(loadCachedChannels()?.recent).toEqual([]);
  });

  it('overwrites the previous cache on save', () => {
    saveCachedChannels([sampleRoom({ id: 'old' })], []);
    saveCachedChannels([sampleRoom({ id: 'new' })], []);
    const loaded = loadCachedChannels();
    expect(loaded?.rooms).toHaveLength(1);
    expect(loaded?.rooms[0].id).toBe('new');
  });

  it('returns empty arrays (not null) for a cached-but-empty list, so a real empty response is distinguishable from a cold cache', () => {
    saveCachedChannels([sampleRoom()], [sampleRecent()]);
    saveCachedChannels([], []);
    expect(loadCachedChannels()).toEqual({ rooms: [], recent: [] });
  });
});
