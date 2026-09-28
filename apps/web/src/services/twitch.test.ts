import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { connect, disconnect, handleMessage, handleUserNotice, ircCommand, setActiveStores, simulateDisconnect } from './twitch';
import { identifyMultiple } from './llm';
import type { ChannelStores } from '../store/channel';
import type { Request } from '@filadbd/shared';

vi.mock('./llm', () => ({
  identifyMultiple: vi.fn(async () => []),
}));

vi.mock('../store/auth', () => ({
  useAuth: { getState: () => ({ isAuthenticated: true }) },
}));

const identifyMultipleMock = vi.mocked(identifyMultiple);

function donationRaw(donor: string, amount: number, message: string): string {
  return `@display-name=livepix;color=#FF0000 :livepix!livepix@livepix.tmi.twitch.tv PRIVMSG #test :${donor} doou R$ ${amount},00: ${message}`;
}

describe('handleMessage — above-minimum donation routing', () => {
  let added: Request[];

  beforeEach(() => {
    added = [];
    setActiveStores({
      useSources: {
        getState: () => ({
          enabled: { donation: true, resub: true },
          chatCommand: '!fila',
          minDonation: 5,
          extrasConfig: undefined,
        }),
      },
      useRequests: {
        getState: () => ({ add: (r: Request) => added.push(r) }),
      },
    } as unknown as ChannelStores);
  });

  afterEach(() => {
    identifyMultipleMock.mockClear();
    setActiveStores(null);
  });

  it('skips the LLM and adds one local request when an above-min donation is exactly one character', () => {
    // R$50 with min R$5 → entitlement 10 (multi-request path)
    handleMessage(donationRaw('Bob', 50, 'Trapper'));

    expect(identifyMultipleMock).not.toHaveBeenCalled();
    expect(added).toHaveLength(1);
    expect(added[0].character).toBe('Trapper');
    expect(added[0].type).toBe('killer');
    expect(added[0].needsIdentification).toBe(false);
  });

  it('still calls the LLM when an above-min donation contains more than the character name', () => {
    handleMessage(donationRaw('Bob', 50, 'Trapper e Nurse'));

    expect(identifyMultipleMock).toHaveBeenCalledTimes(1);
    expect(identifyMultipleMock).toHaveBeenCalledWith('Trapper e Nurse', 10, expect.anything());
  });

  it('still calls the LLM when an above-min donation has build text after the character', () => {
    handleMessage(donationRaw('Bob', 50, 'Trapper com mori'));

    expect(identifyMultipleMock).toHaveBeenCalledTimes(1);
  });
});

describe('handleUserNotice — subscription plan and tier parsing', () => {
  let added: Request[];

  beforeEach(() => {
    added = [];
    setActiveStores({
      useSources: {
        getState: () => ({
          enabled: { donation: true, resub: true },
          chatCommand: '!fila',
          minDonation: 5,
          extrasConfig: undefined,
        }),
      },
      useRequests: {
        getState: () => ({ add: (r: Request) => added.push(r) }),
      },
    } as unknown as ChannelStores);
  });

  afterEach(() => {
    setActiveStores(null);
  });

  it('parses Tier 3 subscription plan', () => {
    handleUserNotice('@msg-id=resub;display-name=Bob;msg-param-sub-plan=3000;id=123 :tmi.twitch.tv USERNOTICE #test :Quero Trapper');
    expect(added).toHaveLength(1);
    expect(added[0].subTier).toBe(3);
    expect(added[0].donor).toBe('Bob');
    expect(added[0].source).toBe('resub');
  });

  it('parses Tier 2 subscription plan', () => {
    handleUserNotice('@msg-id=resub;display-name=Alice;msg-param-sub-plan=2000;id=124 :tmi.twitch.tv USERNOTICE #test :Quero Nurse');
    expect(added).toHaveLength(1);
    expect(added[0].subTier).toBe(2);
  });

  it('parses Tier 1 / Prime subscription plans', () => {
    handleUserNotice('@msg-id=resub;display-name=Charlie;msg-param-sub-plan=1000;id=125 :tmi.twitch.tv USERNOTICE #test :Quero Wraith');
    expect(added[0].subTier).toBe(1);

    added = [];
    handleUserNotice('@msg-id=resub;display-name=Delta;msg-param-sub-plan=Prime;id=126 :tmi.twitch.tv USERNOTICE #test :Quero Oni');
    expect(added[0].subTier).toBe(1);
  });

  it('falls back to subscriber badge if sub-plan tag is missing', () => {
    handleUserNotice('@msg-id=resub;display-name=Echo;badges=subscriber/3012,premium/1;id=127 :tmi.twitch.tv USERNOTICE #test :Quero Huntress');
    expect(added[0].subTier).toBe(3);
  });
});

describe('handleMessage — chat command routing and broadcaster bypass', () => {
  let added: Request[];

  beforeEach(() => {
    added = [];
    setActiveStores({
      useSources: {
        getState: () => ({
          enabled: { chat: true },
          chatCommand: '!fila',
          chatTiers: [2, 3], // Only T2 and T3 can request via chat
        }),
      },
      useRequests: {
        getState: () => ({ add: (r: Request) => added.push(r) }),
      },
    } as unknown as ChannelStores);
  });

  afterEach(() => {
    setActiveStores(null);
  });

  it('ignores command if chatter is not a sub', () => {
    handleMessage('@display-name=Bob;subscriber=0;id=111 :bob!bob@tmi.twitch.tv PRIVMSG #testchannel :!fila Trapper');
    expect(added).toHaveLength(0);
  });

  it('ignores command if chatter is a Tier 1 sub but min is Tier 2', () => {
    handleMessage('@display-name=Bob;subscriber=1;badges=subscriber/1000;id=112 :bob!bob@tmi.twitch.tv PRIVMSG #testchannel :!fila Trapper');
    expect(added).toHaveLength(0);
  });

  it('allows command if chatter is a Tier 2 sub', () => {
    handleMessage('@display-name=Bob;subscriber=1;badges=subscriber/2000;id=113 :bob!bob@tmi.twitch.tv PRIVMSG #testchannel :!fila Trapper');
    expect(added).toHaveLength(1);
    expect(added[0].isBroadcaster).toBeFalsy();
    expect(added[0].subTier).toBe(2);
  });

  it('allows command if chatter is the broadcaster via badges (bypassing sub/tier requirements)', () => {
    handleMessage('@display-name=StreamerName;badges=broadcaster/1;id=114 :streamername!streamername@tmi.twitch.tv PRIVMSG #testchannel :!fila Trapper');
    expect(added).toHaveLength(1);
    expect(added[0].isBroadcaster).toBe(true);
    expect(added[0].donor).toBe('StreamerName');
  });
});


describe('request IDs are derived from the Twitch message ID alone', () => {
  let added: Request[];

  beforeEach(() => {
    added = [];
    setActiveStores({
      useSources: {
        getState: () => ({
          enabled: { chat: true, resub: true },
          chatCommand: '!fila',
          chatTiers: [1, 2, 3],
        }),
      },
      useRequests: {
        getState: () => ({ add: (r: Request) => added.push(r) }),
      },
    } as unknown as ChannelStores);
  });

  afterEach(() => {
    vi.useRealTimers();
    setActiveStores(null);
  });

  // Same message, different moment (lock handover, VOD replay): the ID has to match or
  // the server's dedupe lets both copies into the queue.
  it('gives the same chat message the same ID hours apart', () => {
    const raw = '@display-name=Bob;subscriber=1;badges=subscriber/2000;id=abc-123 :bob!bob@tmi.twitch.tv PRIVMSG #testchannel :!fila Trapper';

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T10:00:00Z'));
    handleMessage(raw);
    vi.setSystemTime(new Date('2026-01-01T13:37:42Z'));
    handleMessage(raw);

    expect(added).toHaveLength(2);
    expect(added[0].id).toBe(added[1].id);
  });

  it('gives the same resub the same ID hours apart', () => {
    const raw = '@msg-id=resub;display-name=Bob;msg-param-sub-plan=2000;id=xyz-789 :tmi.twitch.tv USERNOTICE #testchannel :Trapper';

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T10:00:00Z'));
    handleUserNotice(raw);
    vi.setSystemTime(new Date('2026-01-01T13:37:42Z'));
    handleUserNotice(raw);

    expect(added).toHaveLength(2);
    expect(added[0].id).toBe(added[1].id);
  });

  it('keeps IDs inside the safe-integer range, so no low bits are rounded away', () => {
    handleMessage('@display-name=Bob;subscriber=1;badges=subscriber/2000;id=abc-123 :bob!bob@tmi.twitch.tv PRIVMSG #testchannel :!fila Trapper');

    expect(added).toHaveLength(1);
    expect(Number.isSafeInteger(added[0].id)).toBe(true);
  });

  it('separates distinct messages', () => {
    handleMessage('@display-name=Bob;subscriber=1;badges=subscriber/2000;id=msg-1 :bob!bob@tmi.twitch.tv PRIVMSG #testchannel :!fila Trapper');
    handleMessage('@display-name=Bob;subscriber=1;badges=subscriber/2000;id=msg-2 :bob!bob@tmi.twitch.tv PRIVMSG #testchannel :!fila Nurse');

    expect(added).toHaveLength(2);
    expect(added[0].id).not.toBe(added[1].id);
  });
});

describe('ircCommand', () => {
  it('reads the command past the tags and prefix', () => {
    expect(ircCommand(':justinfan1.tmi.twitch.tv 366 justinfan1 #testchannel :End of /NAMES list')).toBe('366');
    expect(ircCommand('PING :tmi.twitch.tv')).toBe('PING');
    expect(ircCommand(':tmi.twitch.tv RECONNECT')).toBe('RECONNECT');
    expect(ircCommand('@id=366;tmi-sent-ts=1790000366000 :bob!bob@bob.tmi.twitch.tv PRIVMSG #testchannel :366')).toBe('PRIVMSG');
    expect(ircCommand('@msg-id=resub :tmi.twitch.tv USERNOTICE #testchannel :oi')).toBe('USERNOTICE');
    expect(ircCommand('')).toBe('');
  });
});

describe('the IRC socket', () => {
  // Tags carry nonces, message ids, timestamps and user ids, and the text is anything the
  // chatter typed. Matching `366` anywhere in the line took ~3% of ordinary messages for the
  // JOIN confirmation and dropped them: their requests never reached the queue.
  const JOINED = ':justinfan1.tmi.twitch.tv 366 justinfan1 #testchannel :End of /NAMES list';
  const chat = (id: string, text: string) =>
    `@badges=subscriber/1;display-name=Bob;id=${id};subscriber=1 :bob!bob@bob.tmi.twitch.tv PRIVMSG #testchannel :${text}`;

  // Like a browser WebSocket, close() only starts the handshake: onclose fires later.
  class FakeSocket {
    static all: FakeSocket[] = [];
    static get last() { return FakeSocket.all[FakeSocket.all.length - 1]; }
    onopen: (() => void) | null = null;
    onmessage: ((e: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    sent: string[] = [];
    closed = false;
    constructor() { FakeSocket.all.push(this); }
    send(data: string) { this.sent.push(data); }
    close() { this.closed = true; }
    finishClose() { this.onclose?.(); }
    receive(...lines: string[]) { this.onmessage?.({ data: lines.join('\r\n') + '\r\n' }); }
  }

  let added: Request[];
  let ircStates: string[];

  beforeEach(() => {
    added = [];
    ircStates = [];
    FakeSocket.all = [];
    vi.stubGlobal('WebSocket', FakeSocket);
    setActiveStores({
      useSources: {
        getState: () => ({
          enabled: { chat: true, resub: true, donation: true },
          chatCommand: '!fila',
          chatTiers: [1, 2, 3],
          minDonation: 5,
        }),
      },
      useRequests: {
        getState: () => ({ add: (r: Request) => added.push(r) }),
      },
      useChannelInfo: {
        getState: () => ({ setIrcConnectionState: (s: string) => ircStates.push(s) }),
      },
    } as unknown as ChannelStores);
    connect('testchannel');
    FakeSocket.last.receive(JOINED);
  });

  afterEach(() => {
    disconnect();
    setActiveStores(null);
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  describe('dispatches lines by command, not by substring', () => {
    it('adds a chat request whose tags contain 366, without re-reporting the join', () => {
      FakeSocket.last.receive('@badges=subscriber/1;display-name=Bob;id=a366b-1;subscriber=1;tmi-sent-ts=1790000366123;user-id=12366 :bob!bob@bob.tmi.twitch.tv PRIVMSG #testchannel :!fila Trapper');

      expect(added).toHaveLength(1);
      expect(added[0].character).toBe('Trapper');
      expect(ircStates).toEqual(['connecting', 'connected']);
    });

    it('adds a donation whose text contains 366', () => {
      FakeSocket.last.receive('@display-name=livepix;color=#FF0000;id=d-1 :livepix!livepix@livepix.tmi.twitch.tv PRIVMSG #testchannel :Bob doou R$ 366,00: Trapper');

      expect(added).toHaveLength(1);
      expect(added[0].source).toBe('donation');
      expect(added[0].character).toBe('Trapper');
    });

    it('adds a resub whose tags contain 366', () => {
      FakeSocket.last.receive('@msg-id=resub;display-name=Bob;msg-param-sub-plan=1000;id=f366-2 :tmi.twitch.tv USERNOTICE #testchannel :Nurse');

      expect(added).toHaveLength(1);
      expect(added[0].character).toBe('Nurse');
    });

    it('leaves the connection state alone on other lines containing 366', () => {
      FakeSocket.last.receive('@emote-only=0;followers-only=-1;r9k=0;room-id=123366;slow=0;subs-only=0 :tmi.twitch.tv ROOMSTATE #testchannel');

      expect(ircStates).toEqual(['connecting', 'connected']);
    });

    it('does not take a chat message that mentions USERNOTICE for a resub', () => {
      FakeSocket.last.receive(chat('m-3', '!fila Trapper USERNOTICE'));

      expect(added).toHaveLength(1);
      expect(added[0].source).toBe('chat');
    });

    it('still answers PING', () => {
      FakeSocket.last.receive('PING :tmi.twitch.tv');
      expect(FakeSocket.last.sent).toContain('PONG :tmi.twitch.tv');
    });
  });

  describe('lifecycle', () => {
    // A replaced socket's close lands after connect() returns. It used to drop the reference
    // to its replacement and schedule a reconnect: two sockets read chat, and disconnect()
    // could reach only one of them.
    it('a socket replaced by connect() stands down when its close lands', () => {
      vi.useFakeTimers();
      const old = FakeSocket.last;
      connect('testchannel');
      const current = FakeSocket.last;
      expect(old.closed).toBe(true);

      old.receive(chat('late-1', '!fila Nurse'));
      old.finishClose();
      vi.advanceTimersByTime(60_000);

      expect(FakeSocket.all).toHaveLength(2);
      expect(added).toHaveLength(0);
      expect(ircStates.at(-1)).toBe('connecting');

      current.receive(JOINED, chat('m-4', '!fila Trapper'));
      expect(added).toHaveLength(1);

      disconnect();
      expect(current.closed).toBe(true);
    });

    it('a quick disconnect + connect keeps the new socket', () => {
      vi.useFakeTimers();
      const old = FakeSocket.last;
      disconnect();
      connect('testchannel');
      old.finishClose();
      vi.advanceTimersByTime(60_000);

      expect(FakeSocket.all).toHaveLength(2);
      expect(ircStates.slice(-2)).toEqual(['disconnected', 'connecting']);
    });

    // Left at 'connecting', the next grant (which connects only from 'disconnected') would
    // never bring chat back: "Conectando..." until a reload.
    it('disconnect() during a reconnect backoff leaves IRC disconnected', () => {
      vi.useFakeTimers();
      FakeSocket.last.finishClose();
      expect(ircStates.at(-1)).toBe('connecting');

      disconnect();
      vi.advanceTimersByTime(60_000);

      expect(ircStates.at(-1)).toBe('disconnected');
      expect(FakeSocket.all).toHaveLength(1);
    });

    it('a socket that drops on its own still reconnects', () => {
      vi.useFakeTimers();
      FakeSocket.last.finishClose();
      expect(ircStates.at(-1)).toBe('connecting');

      vi.advanceTimersByTime(2_000);
      expect(FakeSocket.all).toHaveLength(2);
    });

    it('simulateDisconnect goes through the reconnect path', () => {
      vi.useFakeTimers();
      const old = FakeSocket.last;
      simulateDisconnect();
      expect(old.closed).toBe(true);

      old.finishClose();
      vi.advanceTimersByTime(2_000);
      expect(FakeSocket.all).toHaveLength(2);
    });
  });
});
