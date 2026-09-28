import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RoomLogger, formatLogBody, scrubLogText, SERVICE_NAME } from './logs';

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJsb2dpbiI6InN0cmVhbWVyIn0.c2lnbmF0dXJlLWJ5dGVz';

type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

function sinkMock() {
  return { debug: vi.fn(), log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function shipped(fetcher: { mock: { calls: [string, RequestInit][] } }) {
  return fetcher.mock.calls.map(([url, init]) => ({
    url,
    headers: init.headers as Record<string, string>,
    body: JSON.parse(init.body as string),
  }));
}

describe('RoomLogger', () => {
  let fetcher: ReturnType<typeof vi.fn<FetchFn>>;
  let sink: ReturnType<typeof sinkMock>;

  beforeEach(() => {
    vi.useFakeTimers();
    fetcher = vi.fn<FetchFn>().mockResolvedValue({ ok: true, status: 200 } as Response);
    sink = sinkMock();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('prints to the console with the exact same arguments', () => {
    const logger = new RoomLogger('room', { POSTHOG_KEY: 'phc_test' }, fetcher, Date.now, sink);
    const err = new Error('boom');
    logger.error('[room] D1 sync requests error:', err);
    logger.log('[room] update-request #1', ['character']);
    expect(sink.error).toHaveBeenCalledWith('[room] D1 sync requests error:', err);
    expect(sink.log).toHaveBeenCalledWith('[room] update-request #1', ['character']);
  });

  it('only prints — never ships — without a key or under DEV_MODE', () => {
    for (const env of [{}, { POSTHOG_KEY: 'phc_test', DEV_MODE: 'true' }]) {
      const logger = new RoomLogger('room', env, fetcher, Date.now, sink);
      logger.warn('x');
      logger.flush();
      expect(logger.enabled).toBe(false);
    }
    vi.runAllTimers();
    expect(sink.warn).toHaveBeenCalledTimes(2);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('batches lines into one OTLP request with the service name, severity and room id', () => {
    const now = Date.UTC(2026, 8, 28, 2, 0, 0);
    const logger = new RoomLogger('mandymess', { POSTHOG_KEY: 'phc_test', POSTHOG_HOST: 'https://ph.example/' }, fetcher, () => now, sink);
    logger.log('[mandymess] Connected: c1 (anon) v1 - 1 total');
    logger.warn('[mandymess] JWT verification failed for conn c1');
    logger.error('[mandymess] PERSIST FAILED (3 requests):', new RangeError('too many'));
    expect(fetcher).not.toHaveBeenCalled(); // never on the caller's path

    vi.advanceTimersByTime(2_000);

    const [{ url, headers, body }] = shipped(fetcher);
    expect(url).toBe('https://ph.example/i/v1/logs');
    expect(headers.Authorization).toBe('Bearer phc_test');
    const resource = body.resourceLogs[0].resource.attributes;
    expect(resource).toContainEqual({ key: 'service.name', value: { stringValue: SERVICE_NAME } });
    const records = body.resourceLogs[0].scopeLogs[0].logRecords;
    expect(records.map((r: { severityText: string }) => r.severityText)).toEqual(['info', 'warn', 'error']);
    expect(records.map((r: { severityNumber: number }) => r.severityNumber)).toEqual([9, 13, 17]);
    expect(records[0]).toMatchObject({
      timeUnixNano: `${now}000000`,
      body: { stringValue: '[mandymess] Connected: c1 (anon) v1 - 1 total' },
      attributes: [
        { key: 'room.id', value: { stringValue: 'mandymess' } },
        { key: 'name', value: { stringValue: 'log' } },
      ],
    });
    expect(records[2].body.stringValue).toContain('RangeError: too many');
  });

  it('reports a failed export on the console only, never through itself', async () => {
    fetcher.mockResolvedValue({ ok: false, status: 503 } as Response);
    const logger = new RoomLogger('room', { POSTHOG_KEY: 'phc_test' }, fetcher, Date.now, sink);
    logger.log('a');
    logger.flush();
    await vi.runAllTimersAsync();
    expect(sink.warn).toHaveBeenCalledWith('[room] PostHog logs export failed: 503');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('keeps one export in flight, with a timeout, and ships the rest after it', async () => {
    let release!: (r: Response) => void;
    fetcher.mockReturnValueOnce(new Promise<Response>((r) => { release = r; }));
    const logger = new RoomLogger('room', { POSTHOG_KEY: 'phc_test' }, fetcher, Date.now, sink);
    // A batch goes out at 200 lines; while PostHog hangs, nothing stacks behind it.
    for (let i = 0; i < 450; i++) logger.log(`line ${i}`);
    logger.flush();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);

    release({ ok: true, status: 200 } as Response);
    await vi.runAllTimersAsync();
    const total = shipped(fetcher).reduce((n, b) => n + b.body.resourceLogs[0].scopeLogs[0].logRecords.length, 0);
    expect(total).toBe(450);
  });
});

describe('log body', () => {
  it('joins arguments the way the console shows them', () => {
    expect(formatLogBody(['[r] update-request #1', ['character'], { a: 1 }, 2, undefined])).toBe('[r] update-request #1 ["character"] {"a":1} 2 undefined');
  });

  it('never ships a token, whatever a call site passes', () => {
    expect(scrubLogText(`wss://party/room?token=${JWT}&v=1`)).toBe('wss://party/room?token=[redacted]&v=1');
    expect(scrubLogText(`Authorization: Bearer internal:secret123`)).toBe('Authorization: Bearer [redacted]');
    expect(formatLogBody(['auth', { token: JWT }])).not.toContain(JWT);
  });

  it('truncates huge lines', () => {
    expect(formatLogBody(['x'.repeat(20_000)]).length).toBeLessThan(8_100);
  });
});
