import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { render, act } from '@testing-library/react';
import { ChannelProvider, useChannel } from './ChannelContext';
import { useAuth } from './auth';
import { openQueueOp, closeQueueOp, connectParty, reconnectParty, broadcastIrcStatus } from '../services/party';
import { connect as connectIrc, disconnect as disconnectIrc } from '../services/twitch';
import { toast } from 'sonner';
import { useQueueStatus } from '../hooks/useQueueStatus';
import { t } from '../i18n';

vi.mock('../services/party', () => ({
  connectParty: vi.fn(),
  disconnectParty: vi.fn(),
  reconnectParty: vi.fn(),
  refreshParty: vi.fn(),
  openQueueOp: vi.fn(),
  closeQueueOp: vi.fn(),
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
    getAccessToken: vi.fn(async (): Promise<string | null> => 'token'),
    refresh: vi.fn(async () => true),
  };
  return { useAuth: Object.assign(() => auth, { auth }) };
});

const authMock = (useAuth as unknown as { auth: { getAccessToken: Mock; refresh: Mock } }).auth;

const OWNER = { login: 'streamer', displayName: 'Streamer', avatar: '' };

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

// Simulates what the room's first poll delivers, without the transport.
function sync(stores: Ctx, channel: { status?: 'offline' | 'online' | 'live'; closedByOwner?: boolean } = {}) {
  const status = channel.status ?? (channel.closedByOwner ? 'offline' : 'online');
  act(() => {
    stores.useChannelInfo.getState().setPartyConnectionState('connected');
    stores.useChannelInfo.getState().handlePartyMessage({
      type: 'sync-full',
      requests: [],
      sources: { enabled: { donation: true } },
      channel: { status, owner: status === 'offline' ? null : OWNER, closedByOwner: !!channel.closedByOwner },
    } as never);
  });
}

function channelUpdate(stores: Ctx, channel: { status: 'offline' | 'online' | 'live'; closedByOwner?: boolean }) {
  act(() => {
    stores.useChannelInfo.getState().handlePartyMessage({
      type: 'update-channel',
      channel: { status: channel.status, owner: channel.status === 'offline' ? null : OWNER, closedByOwner: !!channel.closedByOwner },
    } as never);
  });
}

describe('ChannelProvider — every window of the streamer takes requests while the queue is open', () => {
  const ircConnect = vi.mocked(connectIrc);
  const ircDisconnect = vi.mocked(disconnectIrc);
  const ircStatus = vi.mocked(broadcastIrcStatus);

  afterEach(() => vi.clearAllMocks());

  it('joins chat after the first sync of an open queue', () => {
    const get = setup();
    expect(ircConnect).not.toHaveBeenCalled();
    sync(get());
    expect(get().useChannelInfo.getState().hasLock).toBe(true);
    expect(ircConnect).toHaveBeenCalledWith('streamer');
  });

  it('stays off chat while the queue is closed', () => {
    const get = setup();
    sync(get(), { closedByOwner: true });
    expect(get().useChannelInfo.getState().hasLock).toBe(false);
    expect(ircConnect).not.toHaveBeenCalled();
    expect(get().canEditQueue).toBe(true);
  });

  it('keeps taking requests through a connection blip', () => {
    const get = setup();
    sync(get());
    ircDisconnect.mockClear();
    act(() => { get().useChannelInfo.getState().setPartyConnectionState('disconnected'); });
    expect(get().useChannelInfo.getState().hasLock).toBe(true);
    expect(ircDisconnect).not.toHaveBeenCalled();
  });

  it('leaves chat when another window closes the queue, and rejoins when it reopens', () => {
    const get = setup();
    sync(get());
    act(() => { get().useChannelInfo.getState().setIrcConnectionState('connected'); });
    ircDisconnect.mockClear();
    ircConnect.mockClear();

    channelUpdate(get(), { status: 'offline', closedByOwner: true });
    expect(ircDisconnect).toHaveBeenCalled();

    act(() => { get().useChannelInfo.getState().setIrcConnectionState('disconnected'); });
    channelUpdate(get(), { status: 'online' });
    expect(ircConnect).toHaveBeenCalledWith('streamer');
  });

  it('reports chat as live when the queue reopens with chat still joined', () => {
    const get = setup();
    sync(get(), { closedByOwner: true });
    act(() => { get().useChannelInfo.getState().setIrcConnectionState('connected', false); });
    ircStatus.mockClear();
    channelUpdate(get(), { status: 'online' });
    expect(ircStatus).toHaveBeenCalledWith(true);
  });

  it('opens and closes through the room switch', () => {
    const get = setup();
    sync(get());
    act(() => { get().closeQueue(); });
    expect(ircDisconnect).toHaveBeenCalled();
    expect(closeQueueOp).toHaveBeenCalledTimes(1);
    act(() => { get().openQueue(); });
    expect(openQueueOp).toHaveBeenCalledTimes(1);
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
    sync(get());

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
    sync(get());

    drop(get());
    act(() => { vi.advanceTimersByTime(6000); });
    expect(warning).toHaveBeenCalledTimes(1);

    restore(get());
    expect(success).toHaveBeenCalledTimes(1);
  });
});

describe('ChannelProvider — every window of the streamer reports the same state', () => {
  function mount() {
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
    return { get: () => stores!, status: () => status! };
  }

  it('shows the queue as open once any window reads chat', () => {
    const { get, status } = mount();
    sync(get(), { status: 'live' });
    expect(status().state).toBe('open');
    expect(status().text).toBe(t('status.queueOpen'));
  });

  it('shows connecting while the streamer is around but no window reads chat yet', () => {
    const { get, status } = mount();
    sync(get(), { status: 'online' });
    expect(status().state).toBe('connecting');
  });
});

describe('ChannelProvider — the streamer never edits through an unauthenticated socket', () => {
  const connect = vi.mocked(connectParty);
  const reconnect = vi.mocked(reconnectParty);
  const error = vi.mocked(toast.error);

  afterEach(() => {
    authMock.getAccessToken.mockImplementation(async () => 'token');
    authMock.refresh.mockImplementation(async () => true);
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  // What the provider handed the socket: the per-connect token getter and the message handler.
  function socketArgs() {
    const [, getToken, onMessage] = connect.mock.calls[connect.mock.calls.length - 1];
    return { getToken, onMessage };
  }

  it('hands the socket a token getter, so reconnects ask for a current token', async () => {
    setup();
    const { getToken } = socketArgs();

    authMock.getAccessToken.mockResolvedValueOnce('refreshed-token');
    await expect(getToken()).resolves.toBe('refreshed-token');
    expect(authMock.getAccessToken).toHaveBeenCalledTimes(1);
  });

  it('fails the connection attempt instead of connecting the owner anonymously', async () => {
    setup();
    const { getToken } = socketArgs();

    // A refresh that failed on the network: no token, but still signed in.
    authMock.getAccessToken.mockResolvedValueOnce(null);
    await expect(getToken()).rejects.toThrow();
  });

  it('refreshes the token and fetches the room again when the server refuses an edit, without an error toast', async () => {
    setup();
    const { onMessage } = socketArgs();

    await act(async () => {
      onMessage({ type: 'server-error', code: 'not_room_owner', message: 'Apenas o dono do canal pode gerenciar a fila.' });
    });
    expect(authMock.refresh).toHaveBeenCalledTimes(1);
    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
  });

  it('does not turn a server that keeps refusing into a reconnect loop', async () => {
    vi.useFakeTimers();
    setup();
    const { onMessage } = socketArgs();
    const refuse = () => onMessage({ type: 'server-error', code: 'not_room_owner', message: '' });

    await act(async () => { refuse(); refuse(); refuse(); });
    expect(authMock.refresh).toHaveBeenCalledTimes(1);

    await act(async () => { vi.advanceTimersByTime(61_000); refuse(); });
    expect(authMock.refresh).toHaveBeenCalledTimes(2);
  });

  it('does not reconnect when the refresh fails', async () => {
    authMock.refresh.mockResolvedValueOnce(false);
    setup();
    const { onMessage } = socketArgs();

    await act(async () => {
      onMessage({ type: 'server-error', code: 'not_room_owner', message: '' });
    });
    expect(reconnect).not.toHaveBeenCalled();
  });
});

describe('ChannelProvider — a refusal the self-heal cannot fix is not silent', () => {
  const connect = vi.mocked(connectParty);
  const warning = vi.mocked(toast.warning);
  const dismiss = vi.mocked(toast.dismiss);

  afterEach(() => {
    authMock.getAccessToken.mockImplementation(async () => 'token');
    authMock.refresh.mockImplementation(async () => true);
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  function socketArgs() {
    const [, getToken, onMessage] = connect.mock.calls[connect.mock.calls.length - 1];
    return { getToken, onMessage };
  }
  const authWarnings = () => warning.mock.calls.filter(([, opts]) => (opts as { id?: string })?.id === 'auth-status');

  it('warns once the heal has failed a few rounds in a row', async () => {
    vi.useFakeTimers();
    setup();
    const { onMessage } = socketArgs();
    const refuse = () => onMessage({ type: 'server-error', code: 'not_room_owner', message: '' });

    await act(async () => { refuse(); });
    await act(async () => { vi.advanceTimersByTime(61_000); refuse(); });
    expect(authWarnings()).toHaveLength(0);

    await act(async () => { vi.advanceTimersByTime(61_000); refuse(); });
    expect(authWarnings()).toHaveLength(1);
  });

  it('takes the warning down when the server accepts an edit again', async () => {
    setup();
    const { onMessage } = socketArgs();
    await act(async () => { onMessage({ type: 'server-error', code: 'not_room_owner', message: '' }); });
    await act(async () => { onMessage({ type: 'delete-request', id: 1 }); });
    expect(dismiss).toHaveBeenCalledWith('auth-status');
  });

  it('warns when the streamer session keeps failing to get a token', async () => {
    setup();
    const { getToken } = socketArgs();
    authMock.getAccessToken.mockResolvedValue(null);
    for (let i = 0; i < 4; i++) await expect(getToken()).rejects.toThrow();
    expect(authWarnings()).toHaveLength(0);
    await expect(getToken()).rejects.toThrow();
    expect(authWarnings()).toHaveLength(1);
  });

  it('answers a torn-down socket without a token lookup or an error', async () => {
    const { unmount } = render(<ChannelProvider channel="streamer"><div /></ChannelProvider>);
    const { getToken } = socketArgs();
    unmount();
    authMock.getAccessToken.mockClear();
    await expect(getToken()).resolves.toBeNull();
    expect(authMock.getAccessToken).not.toHaveBeenCalled();
  });
});

describe('ChannelProvider — a failed heal is reported at once', () => {
  const connect = vi.mocked(connectParty);
  const warning = vi.mocked(toast.warning);
  const reconnect = vi.mocked(reconnectParty);

  afterEach(() => vi.clearAllMocks());

  it('warns as soon as an edit is refused again after a heal', async () => {
    // A review once measured ~2 minutes of silence here when two services disagreed on
    // JWT_SECRET: the refusals inside the cooldown never counted.
    setup();
    const [, , onMessage] = connect.mock.calls[connect.mock.calls.length - 1];
    const authWarnings = () => warning.mock.calls.filter(([, opts]) => (opts as { id?: string })?.id === 'auth-status');

    await act(async () => { onMessage({ type: 'server-error', code: 'not_room_owner', message: '' }); });
    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(authWarnings()).toHaveLength(0);

    await act(async () => { onMessage({ type: 'server-error', code: 'not_room_owner', message: '' }); });

    expect(authWarnings()).toHaveLength(1);
    expect(authWarnings()[0][1]).toMatchObject({ duration: Infinity });
  });
});
