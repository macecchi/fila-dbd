import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sign } from 'hono/jwt';
import app from './index';

// Mock gemini
vi.mock('./gemini', () => ({
  extractCharacters: vi.fn().mockResolvedValue([
    { character: 'Meg Thomas', type: 'survivor' },
  ]),
}));

// Type definitions for API responses
interface ErrorResponse {
  error: string;
}

interface UserResponse {
  id: string;
  login: string;
  display_name: string;
  profile_image_url: string;
}

interface TokenResponse {
  access_token: string;
}

interface CharacterResponse {
  character: string;
  type: string;
}

// In-memory KV mock
function createMockKV() {
  const store = new Map<string, { value: string; expiry?: number }>();
  return {
    get: vi.fn(async (key: string) => {
      const entry = store.get(key);
      if (!entry) return null;
      if (entry.expiry && Date.now() > entry.expiry) {
        store.delete(key);
        return null;
      }
      return entry.value;
    }),
    put: vi.fn(async (key: string, value: string, opts?: { expirationTtl?: number }) => {
      const expiry = opts?.expirationTtl ? Date.now() + opts.expirationTtl * 1000 : undefined;
      store.set(key, { value, expiry });
    }),
    _store: store,
  };
}

const mockCache = createMockKV();

function createMockDB() {
  const statements: Array<{ sql: string; bindings: unknown[] }> = [];
  const mockStatement = {
    bind: vi.fn(function (...args: unknown[]) {
      statements[statements.length - 1].bindings = args;
      return mockStatement;
    }),
    run: vi.fn().mockResolvedValue({ success: true }),
    all: vi.fn().mockResolvedValue({ results: [] }),
    first: vi.fn().mockResolvedValue(null),
  };
  return {
    prepare: vi.fn((sql: string) => {
      statements.push({ sql, bindings: [] });
      return mockStatement;
    }),
    batch: vi.fn().mockResolvedValue([]),
    _statements: statements,
    _mockStatement: mockStatement,
  };
}

const mockDB = createMockDB();

const TEST_ENV = {
  TWITCH_CLIENT_ID: 'test-client-id',
  TWITCH_CLIENT_SECRET: 'test-client-secret',
  JWT_SECRET: 'test-jwt-secret-that-is-long-enough',
  FRONTEND_URL: 'https://example.com/app',
  GEMINI_API_KEY: 'test-gemini-key',
  INTERNAL_API_SECRET: 'test-internal-secret',
  CACHE: mockCache,
  DB: mockDB,
};

// Helper to create a valid JWT
async function createTestToken(payload: Record<string, unknown> = {}, expiresIn = 3600) {
  const now = Math.floor(Date.now() / 1000);
  return sign(
    {
      sub: '12345',
      login: 'testuser',
      display_name: 'TestUser',
      profile_image_url: 'https://example.com/avatar.png',
      exp: now + expiresIn,
      ...payload,
    },
    TEST_ENV.JWT_SECRET,
    'HS256'
  );
}

describe('Hono API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCache._store.clear();
    mockDB._statements.length = 0;
  });

  describe('CORS', () => {
    it('includes CORS headers for frontend origin', async () => {
      const res = await app.request('/auth/me', {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://example.com',
        },
      }, TEST_ENV);

      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://example.com');
      expect(res.headers.get('Access-Control-Allow-Credentials')).toBe('true');
    });

    it('allows preview subdomain origins', async () => {
      const res = await app.request('/auth/me', {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://91e2b42d.example.com',
        },
      }, TEST_ENV);

      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://91e2b42d.example.com');
      expect(res.headers.get('Access-Control-Allow-Credentials')).toBe('true');
    });

    it('rejects unrelated origins', async () => {
      const res = await app.request('/auth/me', {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://evil.com',
        },
      }, TEST_ENV);

      expect(res.headers.get('Access-Control-Allow-Origin')).not.toBe('https://evil.com');
    });
  });

  // Note: OAuth token exchange (POST /auth/token) requires integration testing
  // with the arctic library and Twitch API, which is complex to mock properly.
  // These are tested manually and in staging environments.

  describe('POST /auth/token', () => {
    it('returns 400 when code or redirect_uri is missing', async () => {
      const res = await app.request('/auth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }, TEST_ENV);

      expect(res.status).toBe(400);
      const body = await res.json() as ErrorResponse;
      expect(body.error).toBe('missing_code_or_redirect_uri');
    });
  });

  describe('POST /auth/refresh', () => {
    it('returns 400 when refresh_token is missing', async () => {
      const res = await app.request('/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }, TEST_ENV);

      expect(res.status).toBe(400);
      const body = await res.json() as ErrorResponse;
      expect(body.error).toBe('missing_refresh_token');
    });

    it('returns 401 when refresh_token is invalid', async () => {
      const res = await app.request('/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: 'invalid-token' }),
      }, TEST_ENV);

      expect(res.status).toBe(401);
      const body = await res.json() as ErrorResponse;
      expect(body.error).toBe('invalid_refresh_token');
    });

    it('returns new access_token when refresh_token is valid', async () => {
      const refreshToken = await createTestToken({}, 60 * 60 * 24 * 90); // 90 days

      const res = await app.request('/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: refreshToken }),
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json() as TokenResponse;
      expect(body.access_token).toBeDefined();
      expect(typeof body.access_token).toBe('string');
    });
  });

  describe('GET /auth/me', () => {
    it('returns 401 when Authorization header is missing', async () => {
      const res = await app.request('/auth/me', {}, TEST_ENV);

      expect(res.status).toBe(401);
      const body = await res.json() as ErrorResponse;
      expect(body.error).toBe('unauthorized');
    });

    it('returns 401 when Authorization header format is wrong', async () => {
      const res = await app.request('/auth/me', {
        headers: { Authorization: 'Basic abc123' },
      }, TEST_ENV);

      expect(res.status).toBe(401);
    });

    it('returns 401 when token is invalid', async () => {
      const res = await app.request('/auth/me', {
        headers: { Authorization: 'Bearer invalid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(401);
      const body = await res.json() as ErrorResponse;
      expect(body.error).toBe('invalid_token');
    });

    it('returns 401 when token is expired', async () => {
      const expiredToken = await createTestToken({}, -3600); // expired 1 hour ago

      const res = await app.request('/auth/me', {
        headers: { Authorization: `Bearer ${expiredToken}` },
      }, TEST_ENV);

      expect(res.status).toBe(401);
    });

    it('returns user info when token is valid', async () => {
      const token = await createTestToken();

      const res = await app.request('/auth/me', {
        headers: { Authorization: `Bearer ${token}` },
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json() as UserResponse;
      expect(body.id).toBe('12345');
      expect(body.login).toBe('testuser');
      expect(body.display_name).toBe('TestUser');
    });
  });

  describe('POST /api/extract-character', () => {
    it('returns 401 when not authenticated', async () => {
      const res = await app.request('/api/extract-character', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'quero meg' }),
      }, TEST_ENV);

      expect(res.status).toBe(401);
    });

    it('returns 400 when message is missing', async () => {
      const token = await createTestToken();

      const res = await app.request('/api/extract-character', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({}),
      }, TEST_ENV);

      expect(res.status).toBe(400);
      const body = await res.json() as ErrorResponse;
      expect(body.error).toBe('invalid_input');
    });

    it('returns character extraction result', async () => {
      const token = await createTestToken();

      const res = await app.request('/api/extract-character', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ message: 'quero meg' }),
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json() as CharacterResponse;
      expect(body.character).toBe('Meg Thomas');
      expect(body.type).toBe('survivor');
    });

    it('truncates messages exceeding 1000 UTF-16 units instead of rejecting', async () => {
      const { extractCharacters } = await import('./gemini');
      const token = await createTestToken();
      const longMessage = 'a'.repeat(1500);

      const res = await app.request('/api/extract-character', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ message: longMessage }),
      }, TEST_ENV);

      expect(res.status).toBe(200);
      expect(vi.mocked(extractCharacters)).toHaveBeenCalledWith(
        'a'.repeat(1000), TEST_ENV.GEMINI_API_KEY, 1, []
      );
    });

    it('does not leave a lone surrogate when truncation splits an emoji', async () => {
      const { extractCharacters } = await import('./gemini');
      const token = await createTestToken();
      // 999 chars then an emoji (2 UTF-16 units) straddling the 1000 boundary
      const longMessage = 'a'.repeat(999) + '😀'.repeat(10);

      const res = await app.request('/api/extract-character', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ message: longMessage }),
      }, TEST_ENV);

      expect(res.status).toBe(200);
      expect(vi.mocked(extractCharacters)).toHaveBeenCalledWith(
        'a'.repeat(999), TEST_ENV.GEMINI_API_KEY, 1, []
      );
    });

    it('accepts message at exactly 1000 characters without truncation', async () => {
      const { extractCharacters } = await import('./gemini');
      const token = await createTestToken();
      const exactMessage = 'a'.repeat(1000);

      const res = await app.request('/api/extract-character', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ message: exactMessage }),
      }, TEST_ENV);

      expect(res.status).toBe(200);
      expect(vi.mocked(extractCharacters)).toHaveBeenCalledWith(
        exactMessage, TEST_ENV.GEMINI_API_KEY, 1, []
      );
    });

    it('returns 429 when daily limit is exceeded', async () => {
      const token = await createTestToken();

      // Pre-fill the rate limit counter to the limit
      const today = new Date().toISOString().slice(0, 10);
      await mockCache.put(`ratelimit:extract:12345:${today}`, '200');

      const res = await app.request('/api/extract-character', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ message: 'quero meg' }),
      }, TEST_ENV);

      expect(res.status).toBe(429);
      const body = await res.json() as ErrorResponse & { limit: number };
      expect(body.error).toBe('daily_limit_exceeded');
      expect(body.limit).toBe(200);
    });

    it('increments rate limit counter after successful extraction', async () => {
      const token = await createTestToken();

      const res = await app.request('/api/extract-character', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ message: 'quero meg' }),
      }, TEST_ENV);

      expect(res.status).toBe(200);

      const today = new Date().toISOString().slice(0, 10);
      expect(mockCache.put).toHaveBeenCalledWith(
        `ratelimit:extract:12345:${today}`,
        '1',
        { expirationTtl: 86400 }
      );
    });

    it('returns 502 when Gemini fails', async () => {
      const { extractCharacters } = await import('./gemini');
      vi.mocked(extractCharacters).mockRejectedValueOnce(new Error('API rate limit'));

      const token = await createTestToken();

      const res = await app.request('/api/extract-character', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ message: 'quero meg' }),
      }, TEST_ENV);

      expect(res.status).toBe(502);
      const body = await res.json() as ErrorResponse;
      expect(body.error).toBe('llm_error');
    });

    it('returns a characters array (single result) and flat mirror', async () => {
      const token = await createTestToken();

      const res = await app.request('/api/extract-character', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ message: 'quero meg' }),
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json() as {
        characters: Array<{ character: string; type: string }>;
        character?: string;
        type?: string;
      };
      expect(Array.isArray(body.characters)).toBe(true);
      expect(body.characters).toHaveLength(1);
      expect(body.characters[0]).toMatchObject({ character: 'Meg Thomas', type: 'survivor' });
      expect(body.character).toBe('Meg Thomas');
      expect(body.type).toBe('survivor');
    });

    it('returns multiple characters when LLM yields more than one', async () => {
      const { extractCharacters } = await import('./gemini');
      vi.mocked(extractCharacters).mockResolvedValueOnce([
        { character: 'Trapper', type: 'killer' },
        { character: 'Trapper', type: 'killer' },
        { character: 'Nurse', type: 'killer' },
      ]);

      const token = await createTestToken();
      const res = await app.request('/api/extract-character', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ message: '2 de trapper e 1 de nurse', maxCount: 3 }),
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json() as { characters: Array<{ character: string }>; character?: string };
      expect(body.characters.map(c => c.character)).toEqual(['Trapper', 'Trapper', 'Nurse']);
      expect(body.character).toBe('Trapper');
    });

    it('clamps maxCount to [1, 10]', async () => {
      const { extractCharacters } = await import('./gemini');
      vi.mocked(extractCharacters).mockResolvedValueOnce([{ character: 'Meg Thomas', type: 'survivor' }]);

      const token = await createTestToken();
      await app.request('/api/extract-character', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ message: 'meg', maxCount: 50 }),
      }, TEST_ENV);

      expect(vi.mocked(extractCharacters).mock.calls[0][2]).toBe(10);

      vi.mocked(extractCharacters).mockResolvedValueOnce([{ character: 'Meg Thomas', type: 'survivor' }]);
      await app.request('/api/extract-character', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ message: 'meg', maxCount: 0 }),
      }, TEST_ENV);

      expect(vi.mocked(extractCharacters).mock.calls[1][2]).toBe(1);
    });

    it('returns empty array and empty flat mirror when LLM yields nothing', async () => {
      const { extractCharacters } = await import('./gemini');
      vi.mocked(extractCharacters).mockResolvedValueOnce([]);

      const token = await createTestToken();
      const res = await app.request('/api/extract-character', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ message: 'oi tudo bem?' }),
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json() as { characters: unknown[]; character?: string; type?: string };
      expect(body.characters).toEqual([]);
      expect(body.character).toBe('');
      expect(body.type).toBe('none');
    });

    it('forwards extras param to extractCharacters', async () => {
      const { extractCharacters } = await import('./gemini');
      vi.mocked(extractCharacters).mockClear();
      vi.mocked(extractCharacters).mockResolvedValueOnce([
        { character: 'Krasue', type: 'killer', matchedTerm: 'kraseu', build: { text: 'lethal, dissolution', matchedTerms: ['lethal, dissolution'] } },
      ]);

      const token = await createTestToken();
      const res = await app.request('/api/extract-character', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ message: 'kraseu de lethal, dissolution', maxCount: 1, extras: ['build'] }),
      }, TEST_ENV);

      expect(res.status).toBe(200);
      expect(vi.mocked(extractCharacters)).toHaveBeenCalledWith(
        'kraseu de lethal, dissolution',
        expect.any(String),
        1,
        ['build']
      );
      const body = await res.json() as { characters: Array<{ character: string; build?: { text: string; matchedTerms?: string[] } }> };
      expect(body.characters[0].build).toEqual({ text: 'lethal, dissolution', matchedTerms: ['lethal, dissolution'] });
    });
  });

  describe('PUT /internal/rooms/:roomId/sources', () => {
    const internalAuth = 'Bearer internal:test-internal-secret';

    it('persists sources settings to D1 sources_config column', async () => {
      const bindCalls: unknown[][] = [];
      const mockDB2 = {
        prepare: vi.fn(() => ({
          bind: vi.fn((...args: unknown[]) => {
            bindCalls.push(args);
            return { run: vi.fn().mockResolvedValue({ success: true }) };
          }),
        })),
      };
      const env = { ...TEST_ENV, DB: mockDB2 as unknown as typeof TEST_ENV['DB'] };

      const res = await app.request('/internal/rooms/mandymess/sources', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: internalAuth,
        },
        body: JSON.stringify({
          enabled: { donation: true, chat: true, resub: false, manual: true },
          chatCommand: '!fila',
          chatTiers: [2, 3],
          priority: ['donation', 'chat', 'resub', 'manual'],
          sortMode: 'fifo',
          minDonation: 5,
          extrasConfig: { build: { enabled: true, price: 12 } },
        }),
      }, env);

      expect(res.status).toBe(200);
      const args = bindCalls[0] ?? [];
      const stringified = args[2] as string; // index 2 is the sources_config JSON payload
      const parsed = JSON.parse(stringified);
      expect(parsed.extrasConfig).toEqual({ build: { enabled: true, price: 12 } });
      expect(parsed.chatCommand).toBe('!fila');
    });
  });

  describe('PUT /internal/rooms/:roomId/requests', () => {
    const internalAuth = 'Bearer internal:test-internal-secret';

    it('persists per-row extras to requests.extras column', async () => {
      const bindCalls: unknown[][] = [];
      const mockDB2 = {
        prepare: vi.fn(() => ({
          bind: vi.fn((...args: unknown[]) => {
            bindCalls.push(args);
            return { run: vi.fn().mockResolvedValue({ success: true }) };
          }),
        })),
        batch: vi.fn().mockResolvedValue([]),
      };
      const env = { ...TEST_ENV, DB: mockDB2 as unknown as typeof TEST_ENV['DB'] };

      const extras = [{ type: 'build', text: 'lethal, dissolution', matchedTerms: ['lethal, dissolution'] }];

      const res = await app.request('/internal/rooms/mandymess/requests', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: internalAuth,
        },
        body: JSON.stringify({
          mode: 'partial',
          requests: [{
            id: 1,
            timestamp: new Date().toISOString(),
            donor: 'donor',
            amount: 'R$10',
            amountVal: 10,
            message: 'kraseu de lethal, dissolution',
            character: 'Krasue',
            type: 'killer',
            source: 'donation',
            extras,
          }],
        }),
      }, env);

      expect(res.status).toBe(200);
      const requestBindArgs = bindCalls.find((args) =>
        args.some((a) => typeof a === 'string' && a.includes('"type":"build"'))
      );
      expect(requestBindArgs).toBeDefined();
    });

    it('returns 401 without internal auth', async () => {
      const res = await app.request('/internal/rooms/testroom/requests', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requests: [] }),
      }, TEST_ENV);

      expect(res.status).toBe(401);
    });

    it('full sync marks missing as done (not deleted)', async () => {
      const requests = [
        { id: 'r1', timestamp: '2024-01-01T00:00:00Z', donor: 'user1', source: 'chat' },
        { id: 'r2', timestamp: '2024-01-01T00:01:00Z', donor: 'user2', source: 'chat' },
      ];

      const res = await app.request('/internal/rooms/testroom/requests', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: internalAuth },
        body: JSON.stringify({ requests }),
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const markDoneSql = mockDB._statements.find(s => s.sql.includes('SET done = 1'));
      expect(markDoneSql).toBeDefined();
      expect(markDoneSql!.sql).toContain('NOT IN');
      expect(markDoneSql!.sql).toContain('done_at');
      expect(markDoneSql!.sql).not.toContain('deleted_at');
      expect(markDoneSql!.bindings).toContain('r1');
      expect(markDoneSql!.bindings).toContain('r2');
    });

    it('full sync with empty list marks all as done', async () => {
      const res = await app.request('/internal/rooms/testroom/requests', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: internalAuth },
        body: JSON.stringify({ requests: [] }),
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const markDoneSql = mockDB._statements.find(s => s.sql.includes('SET done = 1'));
      expect(markDoneSql).toBeDefined();
      expect(markDoneSql!.sql).not.toContain('NOT IN');
    });

    it('partial sync only upserts provided requests', async () => {
      const requests = [
        { id: 'r1', timestamp: '2024-01-01T00:00:00Z', donor: 'user1', source: 'chat' },
      ];

      const res = await app.request('/internal/rooms/testroom/requests', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: internalAuth },
        body: JSON.stringify({ requests, mode: 'partial' }),
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json() as { mode: string };
      expect(body.mode).toBe('partial');
      const markDoneSql = mockDB._statements.find(s => s.sql.includes('SET done = 1'));
      expect(markDoneSql).toBeUndefined();
    });

    it('persists origin_msg_id in the upsert SQL and bindings', async () => {
      const requests = [
        {
          id: 1001, timestamp: '2024-01-01T00:00:00Z', donor: 'A', amount: 'R$10',
          amountVal: 10, message: 'Trapper e Nurse', character: 'Trapper', type: 'killer',
          source: 'donation', needsIdentification: false, originMsgId: 'twitch-msg-abc',
        },
      ];

      const res = await app.request('/internal/rooms/testroom/requests', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: internalAuth },
        body: JSON.stringify({ requests, mode: 'partial' }),
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const upsert = mockDB._statements.find(s => s.sql.includes('INSERT INTO requests'));
      expect(upsert).toBeDefined();
      expect(upsert!.sql).toContain('origin_msg_id');
      expect(upsert!.sql).toContain('origin_msg_id = excluded.origin_msg_id');
      expect(upsert!.bindings).toContain('twitch-msg-abc');
    });

    it('binds null origin_msg_id when not provided', async () => {
      const requests = [
        { id: 2001, timestamp: '2024-01-01T00:00:00Z', donor: 'B', source: 'chat' },
      ];

      const res = await app.request('/internal/rooms/testroom/requests', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: internalAuth },
        body: JSON.stringify({ requests, mode: 'partial' }),
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const upsert = mockDB._statements.find(s => s.sql.includes('INSERT INTO requests'));
      expect(upsert).toBeDefined();
      // The last bound argument is origin_msg_id; should be null when not provided.
      expect(upsert!.bindings[upsert!.bindings.length - 1]).toBeNull();
    });

    it('uses batchInChunks for large batches', async () => {
      const requests = Array.from({ length: 85 }, (_, i) => ({
        id: `r${i}`,
        timestamp: '2024-01-01T00:00:00Z',
        donor: `user${i}`,
        source: 'chat',
      }));

      const res = await app.request('/internal/rooms/testroom/requests', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: internalAuth },
        body: JSON.stringify({ requests }),
      }, TEST_ENV);

      expect(res.status).toBe(200);
      // 1 room upsert + 1 mark-done + 85 upserts = 87 statements → 2 batch calls (80 + 7)
      expect(mockDB.batch).toHaveBeenCalledTimes(2);
    });
  });

  describe('GET /internal/rooms/:roomId/requests', () => {
    const internalAuth = 'Bearer internal:test-internal-secret';

    it('returns 401 without internal auth', async () => {
      const res = await app.request('/internal/rooms/testroom/requests', {}, TEST_ENV);

      expect(res.status).toBe(401);
    });

    it('returns pending requests from D1', async () => {
      mockDB._mockStatement.all.mockResolvedValueOnce({
        results: [
          {
            id: 'r1',
            room_id: 'testroom',
            position: 0,
            timestamp: '2024-01-01T00:00:00Z',
            donor: 'user1',
            amount: 'R$10',
            amount_val: 10,
            message: 'quero meg',
            character: 'Meg Thomas',
            type: 'survivor',
            done: 0,
            done_at: null,
            source: 'donation',
            sub_tier: null,
            needs_identification: 0,
          },
        ],
      });

      const res = await app.request('/internal/rooms/testroom/requests', {
        headers: { Authorization: internalAuth },
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json() as { requests: Array<Record<string, unknown>> };
      expect(body.requests).toHaveLength(1);
      expect(body.requests[0].id).toBe('r1');
      expect(body.requests[0].character).toBe('Meg Thomas');
      expect(body.requests[0].done).toBe(false);
      expect(body.requests[0].source).toBe('donation');
    });
  });

  describe('GET /api/rooms/:roomId/requests', () => {
    it('returns 401 without JWT auth', async () => {
      const res = await app.request('/api/rooms/testuser/requests', {}, TEST_ENV);

      expect(res.status).toBe(401);
    });

    it('returns 403 for non-owner', async () => {
      const token = await createTestToken({ login: 'otheruser' });

      const res = await app.request('/api/rooms/testuser/requests', {
        headers: { Authorization: `Bearer ${token}` },
      }, TEST_ENV);

      expect(res.status).toBe(403);
      const body = await res.json() as ErrorResponse;
      expect(body.error).toBe('forbidden');
    });

    it('returns requests for owner', async () => {
      mockDB._mockStatement.all.mockResolvedValueOnce({
        results: [
          {
            id: 'r1',
            room_id: 'testuser',
            position: 0,
            timestamp: '2024-01-01T00:00:00Z',
            donor: 'user1',
            amount: '',
            amount_val: 0,
            message: 'quero meg',
            character: 'Meg Thomas',
            type: 'survivor',
            done: 1,
            done_at: '2024-01-01T01:00:00Z',
            source: 'chat',
            sub_tier: 1,
            needs_identification: 0,
          },
        ],
      });

      const token = await createTestToken({ login: 'testuser' });

      const res = await app.request('/api/rooms/testuser/requests', {
        headers: { Authorization: `Bearer ${token}` },
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json() as { requests: Array<Record<string, unknown>> };
      expect(body.requests).toHaveLength(1);
      expect(body.requests[0].id).toBe('r1');
      expect(body.requests[0].done).toBe(true);
      expect(body.requests[0].doneAt).toBe('2024-01-01T01:00:00Z');
      expect(body.requests[0].subTier).toBe(1);
    });

    it('allows any authenticated user in dev mode', async () => {
      mockDB._mockStatement.all.mockResolvedValueOnce({ results: [] });

      const token = await createTestToken({ login: 'otheruser' });
      const devEnv = { ...TEST_ENV, FRONTEND_URL: 'http://localhost:5173' };

      const res = await app.request('/api/rooms/testuser/requests', {
        headers: { Authorization: `Bearer ${token}` },
      }, devEnv);

      expect(res.status).toBe(200);
      const body = await res.json() as { requests: Array<Record<string, unknown>> };
      expect(body.requests).toHaveLength(0);
    });

    it('maps origin_msg_id from D1 row to originMsgId on response', async () => {
      mockDB._mockStatement.all.mockResolvedValueOnce({
        results: [
          {
            id: 'r1', timestamp: '2024-01-01T00:00:00Z', donor: 'A', amount: 'R$10',
            amount_val: 10, message: 'Trapper e Nurse', character: 'Trapper', type: 'killer',
            done: 0, source: 'donation', needs_identification: 0,
            origin_msg_id: 'twitch-msg-abc',
          },
          {
            id: 'r2', timestamp: '2024-01-01T00:00:00Z', donor: 'A', amount: 'R$10',
            amount_val: 10, message: 'Trapper e Nurse', character: 'Nurse', type: 'killer',
            done: 0, source: 'donation', needs_identification: 0,
            origin_msg_id: 'twitch-msg-abc',
          },
        ],
      });

      const token = await createTestToken({ login: 'testuser' });
      const res = await app.request('/api/rooms/testuser/requests', {
        headers: { Authorization: `Bearer ${token}` },
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json() as { requests: Array<{ id: string; originMsgId?: string }> };
      expect(body.requests).toHaveLength(2);
      expect(body.requests[0].originMsgId).toBe('twitch-msg-abc');
      expect(body.requests[1].originMsgId).toBe('twitch-msg-abc');
    });
  });

  describe('POST /internal/chat/send', () => {
    const internalAuth = 'Bearer internal:test-internal-secret';

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('returns 401 without internal auth', async () => {
      const res = await app.request('/internal/chat/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ broadcaster_login: 'somechannel', message: 'hi' }),
      }, TEST_ENV);

      expect(res.status).toBe(401);
    });

    it('returns 400 when broadcaster_login is missing', async () => {
      const res = await app.request('/internal/chat/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: internalAuth },
        body: JSON.stringify({ message: 'hi' }),
      }, TEST_ENV);

      expect(res.status).toBe(400);
    });

    it('returns 400 when message is missing', async () => {
      const res = await app.request('/internal/chat/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: internalAuth },
        body: JSON.stringify({ broadcaster_login: 'somechannel' }),
      }, TEST_ENV);

      expect(res.status).toBe(400);
    });

    it('returns 400 when message exceeds 500 chars', async () => {
      const res = await app.request('/internal/chat/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: internalAuth },
        body: JSON.stringify({ broadcaster_login: 'somechannel', message: 'x'.repeat(501) }),
      }, TEST_ENV);

      expect(res.status).toBe(400);
      const body = await res.json() as { ok: boolean; reason: string };
      expect(body.reason).toBe('message_too_long');
    });

    it('returns 502 with no_bot_token reason when bot is not authorized', async () => {
      const res = await app.request('/internal/chat/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: internalAuth },
        body: JSON.stringify({ broadcaster_login: 'somechannel', message: 'hi' }),
      }, TEST_ENV);

      expect(res.status).toBe(502);
      const body = await res.json() as { ok: boolean; reason: string };
      expect(body.ok).toBe(false);
      expect(body.reason).toBe('no_bot_token');
    });

    it('returns 200 ok on happy path', async () => {
      const bot = {
        access_token: 'bot-token',
        refresh_token: 'r',
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        user_id: 'bot-id',
        login: 'filadbd',
      };
      await TEST_ENV.CACHE.put('bot_token', JSON.stringify(bot));

      vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('id.twitch.tv/oauth2/token')) {
          return { ok: true, json: async () => ({ access_token: 'app-token', expires_in: 3600 }) };
        }
        if (url.includes('/helix/users')) {
          return { ok: true, json: async () => ({ data: [{ id: 'broadcaster-id' }] }) };
        }
        if (url.includes('/helix/chat/messages')) {
          return { ok: true, status: 200, json: async () => ({ data: [{ message_id: 'msg-1', is_sent: true }] }) };
        }
        return { ok: false, status: 500 };
      }));

      const res = await app.request('/internal/chat/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: internalAuth },
        body: JSON.stringify({ broadcaster_login: 'somechannel', message: '@user pedido na fila!' }),
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json() as { ok: boolean; message_id: string };
      expect(body.ok).toBe(true);
      expect(body.message_id).toBe('msg-1');
    });
  });

  describe('GET /api/chat/mod-status', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('returns 401 without JWT auth', async () => {
      const res = await app.request('/api/chat/mod-status', {}, TEST_ENV);
      expect(res.status).toBe(401);
    });

    it('returns no_bot_token when bot is not authorized', async () => {
      const token = await createTestToken({ login: 'mandymess' });

      const res = await app.request('/api/chat/mod-status', {
        headers: { Authorization: `Bearer ${token}` },
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json() as { ok: boolean; reason?: string };
      expect(body.ok).toBe(false);
      expect(body.reason).toBe('no_bot_token');
    });

    it('returns is_mod=true when bot is modded in caller channel', async () => {
      const bot = {
        access_token: 'bot-token',
        refresh_token: 'r',
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        user_id: 'bot-id',
        login: 'filadbd',
      };
      await TEST_ENV.CACHE.put('bot_token', JSON.stringify(bot));

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ broadcaster_login: 'mandymess' }] }),
      }));

      const token = await createTestToken({ login: 'mandymess' });

      const res = await app.request('/api/chat/mod-status', {
        headers: { Authorization: `Bearer ${token}` },
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json() as { ok: boolean; is_mod: boolean; bot_login: string };
      expect(body.ok).toBe(true);
      expect(body.is_mod).toBe(true);
      expect(body.bot_login).toBe('filadbd');
    });

    it('returns is_mod=false when bot is not in caller\'s mod list', async () => {
      const bot = {
        access_token: 'bot-token',
        refresh_token: 'r',
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        user_id: 'bot-id',
        login: 'filadbd',
      };
      await TEST_ENV.CACHE.put('bot_token', JSON.stringify(bot));

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ broadcaster_login: 'someoneelse' }] }),
      }));

      const token = await createTestToken({ login: 'mandymess' });

      const res = await app.request('/api/chat/mod-status', {
        headers: { Authorization: `Bearer ${token}` },
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json() as { ok: boolean; is_mod: boolean };
      expect(body.ok).toBe(true);
      expect(body.is_mod).toBe(false);
    });
  });
});
