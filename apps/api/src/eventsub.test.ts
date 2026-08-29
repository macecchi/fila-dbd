import { describe, it, expect } from 'vitest';
import { verifyEventSubSignature } from './eventsub';
import app from './index';

const SECRET = 'test-eventsub-secret';

async function signMessage(secret: string, messageId: string, timestamp: string, body: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(`${messageId}${timestamp}${body}`)));
  return 'sha256=' + [...sig].map((b) => b.toString(16).padStart(2, '0')).join('');
}

describe('verifyEventSubSignature', () => {
  const messageId = 'msg-123';

  it('accepts a valid signature', async () => {
    const timestamp = new Date().toISOString();
    const body = '{"hello":"world"}';
    const header = await signMessage(SECRET, messageId, timestamp, body);
    expect(await verifyEventSubSignature(SECRET, messageId, timestamp, body, header)).toBe(true);
  });

  it('rejects a tampered body', async () => {
    const timestamp = new Date().toISOString();
    const header = await signMessage(SECRET, messageId, timestamp, '{"a":1}');
    expect(await verifyEventSubSignature(SECRET, messageId, timestamp, '{"a":2}', header)).toBe(false);
  });

  it('rejects a signature made with the wrong secret', async () => {
    const timestamp = new Date().toISOString();
    const body = '{}';
    const header = await signMessage('other-secret', messageId, timestamp, body);
    expect(await verifyEventSubSignature(SECRET, messageId, timestamp, body, header)).toBe(false);
  });

  it('rejects stale timestamps (replay)', async () => {
    const timestamp = new Date(Date.now() - 11 * 60 * 1000).toISOString();
    const body = '{}';
    const header = await signMessage(SECRET, messageId, timestamp, body);
    expect(await verifyEventSubSignature(SECRET, messageId, timestamp, body, header)).toBe(false);
  });

  it('rejects malformed signature headers', async () => {
    const timestamp = new Date().toISOString();
    expect(await verifyEventSubSignature(SECRET, messageId, timestamp, '{}', 'sha256=nothex')).toBe(false);
    expect(await verifyEventSubSignature(SECRET, messageId, timestamp, '{}', 'md5=abcd')).toBe(false);
    expect(await verifyEventSubSignature(SECRET, messageId, timestamp, '{}', '')).toBe(false);
  });
});

describe('POST /twitch/eventsub', () => {
  const ENV = {
    TWITCH_CLIENT_ID: 'test-client-id',
    TWITCH_CLIENT_SECRET: 'test-client-secret',
    JWT_SECRET: 'test-jwt-secret-that-is-long-enough',
    FRONTEND_URL: 'https://example.com',
    GEMINI_API_KEY: 'k',
    INTERNAL_API_SECRET: 's',
    PARTY_HOST: '',
    EVENTSUB_SECRET: SECRET,
    CACHE: { get: async () => null, put: async () => {}, delete: async () => {} },
    DB: {},
  };

  async function post(body: string, messageType: string, opts: { sign?: boolean } = {}) {
    const messageId = crypto.randomUUID();
    const timestamp = new Date().toISOString();
    const signature = opts.sign === false
      ? 'sha256=' + '0'.repeat(64)
      : await signMessage(SECRET, messageId, timestamp, body);
    return app.request('/twitch/eventsub', {
      method: 'POST',
      headers: {
        'Twitch-Eventsub-Message-Id': messageId,
        'Twitch-Eventsub-Message-Timestamp': timestamp,
        'Twitch-Eventsub-Message-Signature': signature,
        'Twitch-Eventsub-Message-Type': messageType,
        'Content-Type': 'application/json',
      },
      body,
    }, ENV);
  }

  it('answers the webhook verification challenge with the raw challenge', async () => {
    const body = JSON.stringify({ challenge: 'pogchamp-kappa-360noscope-vohiyo', subscription: { id: '1', type: 'stream.online' } });
    const res = await post(body, 'webhook_callback_verification');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('pogchamp-kappa-360noscope-vohiyo');
    expect(res.headers.get('Content-Type')).toContain('text/plain');
  });

  it('rejects an invalid signature', async () => {
    const body = JSON.stringify({ challenge: 'x' });
    const res = await post(body, 'webhook_callback_verification', { sign: false });
    expect(res.status).toBe(403);
  });

  it('returns 503 when EVENTSUB_SECRET is not configured', async () => {
    const res = await app.request('/twitch/eventsub', { method: 'POST', body: '{}' }, { ...ENV, EVENTSUB_SECRET: undefined });
    expect(res.status).toBe(503);
  });

  it('acknowledges revocation messages', async () => {
    const body = JSON.stringify({ subscription: { id: '1', type: 'stream.online', condition: {} } });
    const res = await post(body, 'revocation');
    expect(res.status).toBe(204);
  });
});
