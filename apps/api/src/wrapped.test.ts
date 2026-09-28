import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sign } from 'hono/jwt';
import app from './index';
import { computeWrappedStats, generateWrappedNarrative } from './wrapped';
import type { WrappedStats, WrappedPrivate, WrappedNarrative, WrappedPayload } from '@filadbd/shared';

vi.mock('./gemini', () => ({ extractCharacters: vi.fn() }));
vi.mock('./wrapped', () => ({
  computeWrappedStats: vi.fn(),
  generateWrappedNarrative: vi.fn(),
}));
vi.mock('./twitch', () => ({
  getAppToken: vi.fn().mockResolvedValue(null),
  getValidatedAppToken: vi.fn().mockResolvedValue(null),
  fetchProfiles: vi.fn().mockResolvedValue([]),
  fetchStreams: vi.fn().mockResolvedValue([]),
  fetchRecentVodThumbs: vi.fn().mockResolvedValue([]),
  cacheProfiles: vi.fn(),
  sendChatMessage: vi.fn(),
  checkBotIsMod: vi.fn(),
}));

const mockCompute = vi.mocked(computeWrappedStats);
const mockNarrative = vi.mocked(generateWrappedNarrative);

const STATS: WrappedStats = {
  totalRequests: 120,
  doneRequests: 100,
  killerCount: 90,
  survivorCount: 30,
  distinctCharacters: 25,
  distinctRequesters: 40,
  topKillers: [{ character: 'Huntress', count: 20 }],
  topSurvivors: [{ character: 'Meg Thomas', count: 5 }],
  topRequesters: [{ donor: 'viewer1', count: 15 }],
  monthly: [{ month: '2026-03', count: 60 }],
  busiestDay: { date: '2026-03-10', count: 18 },
  sources: { donation: 80, resub: 10, chat: 25, manual: 5 },
  firstRequest: { donor: 'viewer1', character: 'Huntress', timestamp: '2026-01-05T20:00:00Z' },
  loyalFan: { donor: 'viewer2', character: 'Pig', count: 8 },
};

const PRIV: WrappedPrivate = {
  totalAmount: 1234.5,
  donationCount: 80,
  topDonors: [{ donor: 'whale', total: 500 }],
  biggestDonation: { donor: 'whale', amount: 100, character: 'Nurse' },
};

const NARRATIVE: WrappedNarrative = {
  personaTitle: 'A Nação da Huntress',
  personaText: 'text',
  intro: 'intro',
  captions: { totals: 'caption' },
  highlights: [{ title: 'h', text: 't' }],
  funniestNames: [{ name: 'viewer1', comment: 'lol' }],
  superlative: { title: 's', text: 't' },
};

function createMockKV() {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => { store.set(key, value); }),
    _store: store,
  };
}

// DB mock that routes by SQL substring so multiple queries in one request can
// return distinct results.
function createMockDB() {
  const routes: Array<{ match: string; first?: unknown; all?: unknown[]; run?: boolean }> = [];
  const runs: Array<{ sql: string; bindings: unknown[] }> = [];
  return {
    _routes: routes,
    _runs: runs,
    prepare(sql: string) {
      const route = routes.find((r) => sql.includes(r.match));
      let bindings: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) { bindings = args; return stmt; },
        async first() { return route?.first ?? null; },
        async all() { return { results: route?.all ?? [] }; },
        async run() { runs.push({ sql, bindings }); return { success: true }; },
      };
      return stmt;
    },
    batch: vi.fn().mockResolvedValue([]),
  };
}

const JWT_SECRET = 'test-jwt-secret-that-is-long-enough';

async function createTestToken(login = 'streamer') {
  const now = Math.floor(Date.now() / 1000);
  return sign(
    { sub: '99', login, display_name: 'Streamer', profile_image_url: 'https://example.com/a.png', exp: now + 3600 },
    JWT_SECRET,
    'HS256'
  );
}

function makeEnv(db = createMockDB(), cache = createMockKV()) {
  return {
    TWITCH_CLIENT_ID: 'id',
    TWITCH_CLIENT_SECRET: 'secret',
    JWT_SECRET,
    FRONTEND_URL: 'https://example.com',
    GEMINI_API_KEY: 'key',
    INTERNAL_API_SECRET: 'internal',
    CACHE: cache,
    DB: db,
  };
}

const executionCtx = { waitUntil: () => {}, passThroughOnException: () => {} } as any;

const STORED_PAYLOAD: WrappedPayload = {
  edition: '2026.1',
  editionLabel: 'Retrospectiva 2026.1',
  channel: { login: 'streamer', displayName: 'Streamer', avatarUrl: null },
  generatedAt: '2026-08-01T00:00:00Z',
  stats: STATS,
  narrative: NARRATIVE,
  private: PRIV,
};

describe('Wrapped endpoints', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCompute.mockResolvedValue({ stats: STATS, priv: PRIV, sampleMessages: [], requesterNames: ['viewer1'] });
    mockNarrative.mockResolvedValue({ narrative: NARRATIVE, model: 'gemini-3.6-flash' });
  });

  describe('GET /rooms/:roomId/wrapped/:edition (public)', () => {
    it('returns payload with private section stripped', async () => {
      const db = createMockDB();
      db._routes.push({ match: 'FROM wrapped', first: { payload: JSON.stringify(STORED_PAYLOAD) } });
      const res = await app.request('/rooms/streamer/wrapped/2026.1', {}, makeEnv(db), executionCtx);
      expect(res.status).toBe(200);
      const body = await res.json() as { wrapped: WrappedPayload };
      expect(body.wrapped.stats.totalRequests).toBe(120);
      expect(body.wrapped.private).toBeUndefined();
    });

    it('404s when not generated', async () => {
      const res = await app.request('/rooms/streamer/wrapped/2026.1', {}, makeEnv(), executionCtx);
      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/wrapped/:edition (owner)', () => {
    it('requires auth', async () => {
      const res = await app.request('/api/wrapped/2026.1', {}, makeEnv(), executionCtx);
      expect(res.status).toBe(401);
    });

    it('returns full payload including private for the owner', async () => {
      const db = createMockDB();
      db._routes.push({ match: 'FROM wrapped', first: { payload: JSON.stringify(STORED_PAYLOAD) } });
      const token = await createTestToken();
      const res = await app.request('/api/wrapped/2026.1', { headers: { Authorization: `Bearer ${token}` } }, makeEnv(db), executionCtx);
      expect(res.status).toBe(200);
      const body = await res.json() as { wrapped: WrappedPayload };
      expect(body.wrapped.private?.totalAmount).toBe(1234.5);
    });
  });

  describe('POST /api/wrapped/:edition/generate', () => {
    it('rejects unknown editions', async () => {
      const token = await createTestToken();
      const res = await app.request('/api/wrapped/1999.9/generate', { method: 'POST', headers: { Authorization: `Bearer ${token}` } }, makeEnv(), executionCtx);
      expect(res.status).toBe(400);
    });

    it('422s when there is not enough data', async () => {
      mockCompute.mockResolvedValue({ stats: { ...STATS, totalRequests: 3 }, priv: PRIV, sampleMessages: [], requesterNames: [] });
      const token = await createTestToken();
      const res = await app.request('/api/wrapped/2026.1/generate', { method: 'POST', headers: { Authorization: `Bearer ${token}` } }, makeEnv(), executionCtx);
      expect(res.status).toBe(422);
      const body = await res.json() as { error: string; totalRequests: number };
      expect(body.error).toBe('not_enough_data');
      expect(body.totalRequests).toBe(3);
    });

    it('generates, stores in D1, and returns the full payload', async () => {
      const db = createMockDB();
      db._routes.push({ match: 'FROM rooms', first: { display_name: 'Streamer', avatar_url: 'https://a.png' } });
      const token = await createTestToken();
      const res = await app.request('/api/wrapped/2026.1/generate', { method: 'POST', headers: { Authorization: `Bearer ${token}` } }, makeEnv(db), executionCtx);
      expect(res.status).toBe(200);
      const body = await res.json() as { wrapped: WrappedPayload };
      expect(body.wrapped.edition).toBe('2026.1');
      expect(body.wrapped.narrative.personaTitle).toBe('A Nação da Huntress');
      expect(body.wrapped.private?.totalAmount).toBe(1234.5);
      expect(body.wrapped.channel.displayName).toBe('Streamer');

      const insert = db._runs.find((r) => r.sql.includes('INSERT INTO wrapped'));
      expect(insert).toBeDefined();
      expect(insert!.bindings[0]).toBe('streamer');
      expect(insert!.bindings[1]).toBe('2026.1');
      const stored = JSON.parse(insert!.bindings[2] as string) as WrappedPayload;
      expect(stored.private?.totalAmount).toBe(1234.5);
    });

    it('enforces the daily generation limit', async () => {
      const cache = createMockKV();
      const today = new Date().toISOString().slice(0, 10);
      cache._store.set(`ratelimit:wrapped:streamer:${today}`, '5');
      const token = await createTestToken();
      const res = await app.request('/api/wrapped/2026.1/generate', { method: 'POST', headers: { Authorization: `Bearer ${token}` } }, makeEnv(createMockDB(), cache), executionCtx);
      expect(res.status).toBe(429);
    });
  });
});
