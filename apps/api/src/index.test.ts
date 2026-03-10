import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sign } from 'hono/jwt';
import app from './index';

// Mock gemini
vi.mock('./gemini', () => ({
  extractCharacter: vi.fn().mockResolvedValue({
    character: 'Meg Thomas',
    type: 'survivor',
  }),
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

const TEST_ENV = {
  TWITCH_CLIENT_ID: 'test-client-id',
  TWITCH_CLIENT_SECRET: 'test-client-secret',
  JWT_SECRET: 'test-jwt-secret-that-is-long-enough',
  FRONTEND_URL: 'https://example.com/app',
  GEMINI_API_KEY: 'test-gemini-key',
  CACHE: mockCache,
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

  // Note: OAuth routes (/auth/login, /auth/callback) require integration testing
  // with the arctic library and Twitch API, which is complex to mock properly.
  // These are tested manually and in staging environments.

  describe('GET /auth/callback', () => {
    it('redirects with error when code is missing', async () => {
      const res = await app.request('/auth/callback', {}, TEST_ENV);

      expect(res.status).toBe(302);
      const location = res.headers.get('Location');
      expect(location).toContain('error=missing_code');
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

    it('returns 400 when message exceeds 500 characters', async () => {
      const token = await createTestToken();
      const longMessage = 'a'.repeat(501);

      const res = await app.request('/api/extract-character', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ message: longMessage }),
      }, TEST_ENV);

      expect(res.status).toBe(400);
      const body = await res.json() as ErrorResponse & { max: number };
      expect(body.error).toBe('message_too_long');
      expect(body.max).toBe(500);
    });

    it('accepts message at exactly 500 characters', async () => {
      const token = await createTestToken();
      const exactMessage = 'a'.repeat(500);

      const res = await app.request('/api/extract-character', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ message: exactMessage }),
      }, TEST_ENV);

      expect(res.status).toBe(200);
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
      const { extractCharacter } = await import('./gemini');
      vi.mocked(extractCharacter).mockRejectedValueOnce(new Error('API rate limit'));

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
  });
});
