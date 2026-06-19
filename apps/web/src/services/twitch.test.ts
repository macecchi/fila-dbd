import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleMessage, handleUserNotice, setActiveStores } from './twitch';
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

