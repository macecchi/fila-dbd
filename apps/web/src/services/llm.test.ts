import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { identifyCharacter } from './llm';
import type { Request } from '@filadbd/shared';

vi.mock('../store/auth', () => ({
  useAuth: {
    getState: () => ({ isAuthenticated: true, getAccessToken: async () => 'token' }),
  },
}));

function makeRequest(message: string): Request {
  return {
    id: 1,
    timestamp: new Date(),
    donor: 'Donor',
    amount: 'R$10',
    amountVal: 10,
    message,
    character: '',
    type: 'unknown',
    source: 'donation',
  };
}

describe('identifyCharacter — skip LLM when local match is the whole message', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    // Injected by Vite's `define` in the real build; absent under vitest.
    vi.stubGlobal('__APP_VERSION__', 'test');
  });

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it('does not call the LLM when the matched term is the entire message, even with extras requested', async () => {
    const result = await identifyCharacter(makeRequest('Trapper'), ['build'], undefined, () => {});

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.character).toBe('Trapper');
    expect(result.type).toBe('killer');
    expect(result.validating).toBeUndefined();
  });

  it('ignores surrounding whitespace and case when comparing match to message', async () => {
    const result = await identifyCharacter(makeRequest('  trapper  '), ['build'], undefined, () => {});

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.character).toBe('Trapper');
  });

  it('still calls the LLM for extras when the message has text beyond the character name', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ characters: [{ character: 'Trapper', type: 'killer' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const onLLMUpdate = vi.fn();
    const result = await identifyCharacter(
      makeRequest('Trapper com build de mori'),
      ['build'],
      undefined,
      onLLMUpdate
    );

    expect(result.validating).toBe(true);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });

  it('routes a prose message with an embedded local match to the LLM (no extras)', async () => {
    // "Trapper" matches locally but it is context ("a dull Trapper two"), not a
    // request. The local match must NOT short-circuit the LLM anymore.
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ characters: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const onLLMUpdate = vi.fn();
    const result = await identifyCharacter(
      makeRequest('se for o Jason vai ser um Trapper dois sem graça'),
      [],
      undefined,
      onLLMUpdate
    );

    expect(result.validating).toBe(true);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    // LLM is authoritative: it returned no character, so the local guess is dropped.
    await vi.waitFor(() =>
      expect(onLLMUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ character: '', validating: false })
      )
    );
  });
});

describe('identifyCharacter — API failures must not clobber a local match', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('__APP_VERSION__', 'test');
  });

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it('streaming path: an HTTP error keeps the local guess instead of overwriting it', async () => {
    fetchMock.mockResolvedValue(new Response('boom', { status: 500 }));

    const onLLMUpdate = vi.fn();
    const result = await identifyCharacter(
      makeRequest('manda um Trapper ai por favor'),
      [],
      undefined,
      onLLMUpdate
    );

    expect(result.validating).toBe(true);
    await vi.waitFor(() => expect(onLLMUpdate).toHaveBeenCalled());
    const arg = onLLMUpdate.mock.calls.at(-1)![0];
    expect(arg.character).toBe('Trapper');
    expect(arg.type).toBe('killer');
    expect(arg.matchedTerm).toBe('Trapper');
    expect(arg.validating).toBe(false);
  });

  it('streaming path: a network error keeps the local guess', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));

    const onLLMUpdate = vi.fn();
    await identifyCharacter(makeRequest('manda um Trapper ai por favor'), [], undefined, onLLMUpdate);

    await vi.waitFor(() => expect(onLLMUpdate).toHaveBeenCalled());
    const arg = onLLMUpdate.mock.calls.at(-1)![0];
    expect(arg.character).toBe('Trapper');
    expect(arg.validating).toBe(false);
  });

  it('streaming path: the daily-limit error keeps the local guess', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: 'daily_limit_exceeded' }), {
        status: 429,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const onLLMUpdate = vi.fn();
    await identifyCharacter(makeRequest('manda um Trapper ai por favor'), [], undefined, onLLMUpdate);

    await vi.waitFor(() => expect(onLLMUpdate).toHaveBeenCalled());
    const arg = onLLMUpdate.mock.calls.at(-1)![0];
    expect(arg.character).toBe('Trapper');
    expect(arg.validating).toBe(false);
  });

  it('await path (no callback): an HTTP error returns the local guess, not an error sentinel', async () => {
    fetchMock.mockResolvedValue(new Response('boom', { status: 500 }));

    const result = await identifyCharacter(makeRequest('manda um Trapper ai por favor'), []);

    expect(result.character).toBe('Trapper');
    expect(result.type).toBe('killer');
  });

  it('await path (no callback): a successful empty result is authoritative and drops the local guess', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ characters: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const result = await identifyCharacter(makeRequest('um Trapper qualquer no meio da frase'), []);

    expect(result.character).toBe('');
  });
});
