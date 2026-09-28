import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RoomTelemetry, describeRejectedToken, THROTTLE_WINDOW_MS } from './telemetry';

function jwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.signature`;
}

function sentBatches(fetcher: { mock: { calls: [string, RequestInit][] } }) {
  return fetcher.mock.calls.map(([url, init]) => ({ url, body: JSON.parse((init as RequestInit).body as string) }));
}

describe('RoomTelemetry', () => {
  let fetcher: ReturnType<typeof vi.fn<(url: string, init: RequestInit) => Promise<Response>>>;

  beforeEach(() => {
    vi.useFakeTimers();
    fetcher = vi.fn<(url: string, init: RequestInit) => Promise<Response>>().mockResolvedValue({ ok: true, status: 200 } as Response);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('is a no-op without a key', () => {
    const t = new RoomTelemetry('room', {}, fetcher);
    t.capture('x');
    t.captureThrottled('k', 'x');
    vi.runAllTimers();
    expect(t.enabled).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('stays silent under DEV_MODE so local rooms never reach the production project', () => {
    const t = new RoomTelemetry('room', { POSTHOG_KEY: 'phc_test', DEV_MODE: 'true' }, fetcher);
    t.capture('x');
    vi.runAllTimers();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('buffers and flushes one batch to the capture endpoint, tagged with app and channel', () => {
    const t = new RoomTelemetry('streamer', { POSTHOG_KEY: 'phc_test', POSTHOG_HOST: 'https://ph.example' }, fetcher);
    t.capture('a', { n: 1 });
    t.capture('b', { n: 2 });
    expect(fetcher).not.toHaveBeenCalled(); // never on the caller's path

    vi.advanceTimersByTime(2_000);

    const [{ url, body }] = sentBatches(fetcher);
    expect(url).toBe('https://ph.example/batch/');
    expect(body.api_key).toBe('phc_test');
    expect(body.batch.map((e: { event: string }) => e.event)).toEqual(['a', 'b']);
    expect(body.batch[0]).toMatchObject({
      distinct_id: 'streamer',
      properties: { n: 1, app: 'fila-dbd', source: 'partykit', channel: 'streamer', $process_person_profile: false },
    });
  });

  it('swallows a failed flush', async () => {
    fetcher.mockRejectedValue(new Error('network down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const t = new RoomTelemetry('room', { POSTHOG_KEY: 'phc_test' }, fetcher);
    t.capture('a');
    expect(() => t.flush()).not.toThrow();
    await vi.runAllTimersAsync();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('throttles a key to one event per window plus a folded count', () => {
    const t = new RoomTelemetry('room', { POSTHOG_KEY: 'phc_test' }, fetcher, () => Date.now());
    t.captureThrottled('rejected', 'fila_party_mutation_rejected', { message_type: 'toggle-done' });
    for (let i = 0; i < 9; i++) t.captureThrottled('rejected', 'fila_party_mutation_rejected', { message_type: 'reorder' });
    t.flush();

    let events = sentBatches(fetcher).flatMap((b) => b.body.batch);
    expect(events).toHaveLength(1);
    expect(events[0].properties).toMatchObject({ message_type: 'toggle-done', count: 1 });

    vi.advanceTimersByTime(THROTTLE_WINDOW_MS);
    t.flush();
    events = sentBatches(fetcher).flatMap((b) => b.body.batch);
    expect(events).toHaveLength(2);
    expect(events[1].properties).toMatchObject({ message_type: 'reorder', count: 9, throttled: true });

    // The next occurrence opens a fresh window and goes out at once.
    t.captureThrottled('rejected', 'fila_party_mutation_rejected', { message_type: 'toggle-done' });
    t.flush();
    expect(sentBatches(fetcher).flatMap((b) => b.body.batch)).toHaveLength(3);
  });

  it('throttles keys independently', () => {
    const t = new RoomTelemetry('room', { POSTHOG_KEY: 'phc_test' }, fetcher);
    t.captureThrottled('a', 'x');
    t.captureThrottled('b', 'y');
    t.flush();
    expect(sentBatches(fetcher)[0].body.batch).toHaveLength(2);
  });
});

describe('describeRejectedToken', () => {
  const now = Date.UTC(2026, 8, 28, 2, 0, 0);

  it('reports an expired token and how long ago it expired, never the token', () => {
    const token = jwt({ login: 'MandyMess', exp: now / 1000 - 3600 });
    const props = describeRejectedToken(token, now);
    expect(props).toEqual({ reason: 'expired', expired_for_s: 3600, claimed_login: 'mandymess' });
    expect(JSON.stringify(props)).not.toContain(token);
  });

  it('calls a token that is still in date but failed verification invalid', () => {
    expect(describeRejectedToken(jwt({ login: 'x', exp: now / 1000 + 60 }), now)).toMatchObject({ reason: 'invalid', expired_for_s: null });
  });

  it('handles garbage', () => {
    expect(describeRejectedToken('not-a-jwt', now)).toEqual({ reason: 'malformed', expired_for_s: null, claimed_login: null });
  });
});
