import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const posthog = vi.hoisted(() => ({
  init: vi.fn(),
  capture: vi.fn(),
  identify: vi.fn(),
  reset: vi.fn(),
  register: vi.fn(),
}));
vi.mock('posthog-js', () => ({ default: posthog }));

import { scrubProperties, scrubString, track, identify, resetIdentity, initAnalytics, __resetAnalyticsForTests } from './analytics';

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJsb2dpbiI6InN0cmVhbWVyIiwiZXhwIjoxfQ.c2lnbmF0dXJlLWJ5dGVz';

describe('scrubbing', () => {
  it('redacts the party socket token and OAuth params from URLs', () => {
    expect(scrubString(`wss://party.example/parties/main/streamer?token=${JWT}&v=1`))
      .toBe('wss://party.example/parties/main/streamer?token=[redacted]&v=1');
    expect(scrubString('https://filadbd.pages.dev/auth/callback?code=abc123&state=xyz'))
      .toBe('https://filadbd.pages.dev/auth/callback?code=[redacted]&state=[redacted]');
  });

  it('redacts bare JWTs anywhere in a string, e.g. an exception message', () => {
    expect(scrubString(`Bearer ${JWT} rejected`)).toBe('Bearer [redacted] rejected');
  });

  it('redacts token-named keys and walks nested properties', () => {
    const out = scrubProperties({
      $current_url: `https://x/?token=${JWT}`,
      accessToken: 'opaque',
      refresh_token: 'opaque',
      token_ttl_s: 120,
      token_present: true,
      token: 'phc_project_token',
      $exception_list: [{ value: `failed with ${JWT}` }],
    });
    expect(out).toEqual({
      $current_url: 'https://x/?token=[redacted]',
      accessToken: '[redacted]',
      refresh_token: '[redacted]',
      token_ttl_s: 120,
      token_present: true,
      // The SDK's project token: ingestion needs it, so it must pass through.
      token: 'phc_project_token',
      $exception_list: [{ value: 'failed with [redacted]' }],
    });
    expect(JSON.stringify(out)).not.toContain(JWT);
  });
});

describe('analytics loader', () => {
  beforeEach(() => {
    __resetAnalyticsForTests();
    vi.clearAllMocks();
    vi.stubEnv('VITE_POSTHOG_KEY', 'phc_test');
    vi.stubEnv('VITE_POSTHOG_ALLOW_LOCAL', 'true');
    // jsdom has no idle callback; run the deferred load at once.
    vi.stubGlobal('requestIdleCallback', (cb: () => void) => { cb(); return 0; });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('does nothing without a key', async () => {
    vi.stubEnv('VITE_POSTHOG_KEY', '');
    track('x');
    initAnalytics();
    await vi.dynamicImportSettled();
    expect(posthog.init).not.toHaveBeenCalled();
  });

  it('stays off on localhost unless explicitly allowed', async () => {
    vi.stubEnv('VITE_POSTHOG_ALLOW_LOCAL', '');
    track('x');
    initAnalytics();
    await vi.dynamicImportSettled();
    expect(posthog.init).not.toHaveBeenCalled();
    expect(posthog.capture).not.toHaveBeenCalled();
  });

  it('queues events and identity until the SDK loads, then replays them in order', async () => {
    track('fila_party_connected', { reconnect: false });
    identify('MandyMess');
    identify('mandymess'); // already identified: no second call
    initAnalytics();
    await vi.waitFor(() => expect(posthog.init).toHaveBeenCalled(), { timeout: 3000 });

    const [key, config] = posthog.init.mock.calls[0];
    expect(key).toBe('phc_test');
    expect(config).toMatchObject({
      autocapture: false,
      disable_session_recording: true,
      person_profiles: 'identified_only',
      capture_exceptions: true,
    });
    expect(posthog.capture).toHaveBeenCalledWith('fila_party_connected', { reconnect: false });
    expect(posthog.identify).toHaveBeenCalledTimes(1);
    expect(posthog.identify).toHaveBeenCalledWith('mandymess', { twitch_login: 'mandymess' });

    // Loaded: goes straight through.
    track('fila_mutation_acked');
    expect(posthog.capture).toHaveBeenLastCalledWith('fila_mutation_acked', {});
    resetIdentity();
    expect(posthog.reset).toHaveBeenCalled();
  });

  it('runs every event through the scrubber before it is sent', async () => {
    initAnalytics();
    await vi.waitFor(() => expect(posthog.init).toHaveBeenCalled(), { timeout: 3000 });
    const beforeSend = posthog.init.mock.calls[0][1].before_send as (e: unknown) => { properties: Record<string, unknown> };
    const out = beforeSend({ event: '$pageview', properties: { $current_url: `https://x/?token=${JWT}` } });
    expect(out.properties.$current_url).toBe('https://x/?token=[redacted]');
  });
});
