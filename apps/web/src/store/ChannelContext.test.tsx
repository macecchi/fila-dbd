import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { ChannelProvider, useChannel } from './ChannelContext';
import { claimOwnership, releaseOwnership } from '../services/party';
import { connect as connectIrc, disconnect as disconnectIrc } from '../services/twitch';
import { toast } from 'sonner';
import { useQueueStatus } from '../hooks/useQueueStatus';
import { t } from '../i18n';

vi.mock('../services/party', () => ({
  connectParty: vi.fn(),
  disconnectParty: vi.fn(),
  claimOwnership: vi.fn(),
  releaseOwnership: vi.fn(),
  broadcastSetAllExtras: vi.fn(),
  broadcastIrcStatus: vi.fn(),
  broadcastAdd: vi.fn(),
  broadcastUpdate: vi.fn(),
  broadcastToggleDone: vi.fn(),
  broadcastReorder: vi.fn(),
  broadcastDelete: vi.fn(),
  broadcastSetAll: vi.fn(),
  broadcastSources: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), {
    warning: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    dismiss: vi.fn(),
  }),
}));

vi.mock('../services/twitch', () => ({
  setActiveStores: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
}));

// Stable identity, like the real zustand-backed hook: a fresh object per render would
// re-run the connect effect (and its disconnect cleanup) on every state change.
vi.mock('./auth', () => {
  const auth = {
    user: { login: 'streamer', display_name: 'Streamer' },
    isAuthenticated: true,
    getAccessToken: async () => 'token',
  };
  return { useAuth: () => auth };
});

const claimMock = vi.mocked(claimOwnership);

const OWNER = { login: 'streamer', displayName: 'Streamer', avatar: '' };
const OTHER = { login: 'streamer', displayName: 'Streamer', avatar: '' };

type Ctx = ReturnType<typeof useChannel>;

function setup() {
  let stores: Ctx | null = null;
  function Probe() {
    stores = useChannel();
    return null;
  }
  render(
    <ChannelProvider channel="streamer">
      <Probe />
    </ChannelProvider>
  );
  return () => stores!;
}

// Simulates what the socket delivers, without a socket.
function sync(stores: Ctx, owner: typeof OWNER | null) {
  act(() => {
    stores.useChannelInfo.getState().setPartyConnectionState('connected');
    stores.useChannelInfo.getState().handlePartyMessage({
      type: 'sync-full',
      requests: [],
      sources: {},
      channel: { status: owner ? 'online' : 'offline', owner },
    } as never);
  });
}

describe('ChannelProvider — ownership recovers itself', () => {
  beforeEach(() => claimMock.mockClear());
  afterEach(() => vi.clearAllMocks());

  it('claims the room once when the first sync shows it ownerless', () => {
    const get = setup();
    sync(get(), null);
    expect(claimMock).toHaveBeenCalledTimes(1);

    // The grant arrives; nothing re-claims on top of it.
    act(() => {
      get().useChannelInfo.getState().handlePartyMessage({ type: 'ownership-granted' } as never);
    });
    sync(get(), OWNER);
    expect(claimMock).toHaveBeenCalledTimes(1);
  });

  it('does not fight another session for a room that is already owned', () => {
    const get = setup();
    sync(get(), OTHER);
    expect(claimMock).not.toHaveBeenCalled();
  });

  it('takes the room back when the other session goes away', () => {
    const get = setup();
    sync(get(), OTHER);
    expect(claimMock).not.toHaveBeenCalled();

    // The other tab closed: the server clears ownership and broadcasts it.
    act(() => {
      get().useChannelInfo.getState().handlePartyMessage({
        type: 'update-channel',
        channel: { status: 'offline', owner: null },
      } as never);
    });
    expect(claimMock).toHaveBeenCalledTimes(1);
  });

  it('re-claims after a reconnect, since the server drops ownership when our socket closes', () => {
    const get = setup();
    sync(get(), null);
    act(() => {
      get().useChannelInfo.getState().handlePartyMessage({ type: 'ownership-granted' } as never);
    });
    sync(get(), OWNER);
    expect(claimMock).toHaveBeenCalledTimes(1);

    act(() => {
      get().useChannelInfo.getState().setPartyConnectionState('disconnected');
    });
    sync(get(), null);
    expect(claimMock).toHaveBeenCalledTimes(2);
  });

  it('does not spin when the claim is refused and the room stays owned', () => {
    const get = setup();
    sync(get(), null);
    expect(claimMock).toHaveBeenCalledTimes(1);

    act(() => {
      get().useChannelInfo.getState().handlePartyMessage({ type: 'ownership-denied' } as never);
      get().useChannelInfo.getState().handlePartyMessage({
        type: 'update-channel',
        channel: { status: 'online', owner: OTHER },
      } as never);
    });
    expect(claimMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the queue editable for a session that does not hold the lock', () => {
    const get = setup();
    sync(get(), OTHER);
    expect(get().canEditQueue).toBe(true);
    expect(get().useChannelInfo.getState().hasLock).toBe(false);
  });
});

describe('ChannelProvider — reconnects stay quiet unless they last', () => {
  const warning = vi.mocked(toast.warning);
  const success = vi.mocked(toast.success);

  beforeEach(() => {
    warning.mockClear();
    success.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  function drop(stores: Ctx) {
    act(() => {
      stores.useChannelInfo.getState().setPartyConnectionState('disconnected');
    });
  }

  function restore(stores: Ctx) {
    act(() => {
      stores.useChannelInfo.getState().setPartyConnectionState('connected');
    });
  }

  it('says nothing about a blip that reconnects inside the grace window', () => {
    vi.useFakeTimers();
    const get = setup();
    sync(get(), null);

    drop(get());
    act(() => { vi.advanceTimersByTime(2000); });
    restore(get());
    act(() => { vi.advanceTimersByTime(10_000); });

    expect(warning).not.toHaveBeenCalled();
    expect(success).not.toHaveBeenCalled();
  });

  it('warns once an outage outlives the grace window, then confirms the recovery', () => {
    vi.useFakeTimers();
    const get = setup();
    sync(get(), null);

    drop(get());
    act(() => { vi.advanceTimersByTime(6000); });
    expect(warning).toHaveBeenCalledTimes(1);

    restore(get());
    expect(success).toHaveBeenCalledTimes(1);
  });
});

describe('ChannelProvider — every window of the streamer reports the same state', () => {
  it('shows the queue as open even in the session without the lock', () => {
    let status: ReturnType<typeof useQueueStatus> | null = null;
    let stores: Ctx | null = null;
    function Probe() {
      stores = useChannel();
      status = useQueueStatus();
      return null;
    }
    render(
      <ChannelProvider channel="streamer">
        <Probe />
      </ChannelProvider>
    );

    // Another session holds the lock and has IRC live; ours never opened a socket.
    act(() => {
      stores!.useChannelInfo.getState().setPartyConnectionState('connected');
      stores!.useChannelInfo.getState().handlePartyMessage({
        type: 'sync-full',
        requests: [],
        sources: { enabled: { donation: true } },
        channel: { status: 'live', owner: OTHER },
      } as never);
    });

    expect(stores!.useChannelInfo.getState().hasLock).toBe(false);
    expect(status!.state).toBe('open');
    expect(status!.text).toBe(t('status.queueOpen'));
  });

  it('shows connecting while the channel is claimed but chat is not live yet', () => {
    let status: ReturnType<typeof useQueueStatus> | null = null;
    let stores: Ctx | null = null;
    function Probe() {
      stores = useChannel();
      status = useQueueStatus();
      return null;
    }
    render(
      <ChannelProvider channel="streamer">
        <Probe />
      </ChannelProvider>
    );

    act(() => {
      stores!.useChannelInfo.getState().setPartyConnectionState('connected');
      stores!.useChannelInfo.getState().handlePartyMessage({
        type: 'sync-full',
        requests: [],
        sources: { enabled: { donation: true } },
        channel: { status: 'online', owner: OTHER },
      } as never);
    });

    expect(status!.state).toBe('connecting');
  });
});

describe('ChannelProvider — opening and closing work from any window', () => {
  const claim = vi.mocked(claimOwnership);
  const release = vi.mocked(releaseOwnership);
  const ircConnect = vi.mocked(connectIrc);
  const ircDisconnect = vi.mocked(disconnectIrc);

  beforeEach(() => {
    claim.mockClear();
    release.mockClear();
    ircConnect.mockClear();
    ircDisconnect.mockClear();
  });

  afterEach(() => vi.clearAllMocks());

  function grant(stores: Ctx) {
    act(() => {
      stores.useChannelInfo.getState().handlePartyMessage({ type: 'ownership-granted' } as never);
    });
  }

  it('leaves a queue the streamer closed alone instead of reclaiming it', () => {
    const get = setup();
    sync(get(), null);
    grant(get());
    // The grant legitimately opened the queue; what follows must not reopen it.
    claim.mockClear();
    ircConnect.mockClear();

    act(() => { get().closeQueue(); });
    expect(release).toHaveBeenCalledTimes(1);

    // The server frees the room and says the close was deliberate.
    act(() => {
      get().useChannelInfo.getState().handlePartyMessage({
        type: 'update-channel',
        channel: { status: 'offline', owner: null, closedByOwner: true },
      } as never);
    });

    expect(claim).not.toHaveBeenCalled();
    expect(ircConnect).not.toHaveBeenCalled();
  });

  it('does not reopen a queue another window closed', () => {
    const get = setup();
    sync(get(), OTHER);
    claim.mockClear();

    act(() => {
      get().useChannelInfo.getState().handlePartyMessage({
        type: 'update-channel',
        channel: { status: 'offline', owner: null, closedByOwner: true },
      } as never);
    });

    expect(claim).not.toHaveBeenCalled();
  });

  it('closes from a window that does not hold the lock, by taking it first', () => {
    const get = setup();
    sync(get(), OTHER);
    claim.mockClear();

    act(() => { get().closeQueue(); });
    expect(claim).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled();

    // The server hands the lock over; we shut the channel down instead of connecting.
    grant(get());
    expect(ircDisconnect).toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
    expect(ircConnect).not.toHaveBeenCalled();
  });

  it('opens from a window that does not hold the lock, then connects on the grant', () => {
    const get = setup();
    sync(get(), OTHER);
    claim.mockClear();

    act(() => { get().openQueue(); });
    expect(claim).toHaveBeenCalledTimes(1);

    grant(get());
    expect(ircConnect).toHaveBeenCalledWith('streamer');
  });
});
