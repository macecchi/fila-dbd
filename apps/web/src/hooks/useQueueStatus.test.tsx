import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { createRoomStores, type ChannelStores } from '../store/channel';
import type { RoomInfo } from '../services/roomInfo';
import { useQueueStatus } from './useQueueStatus';

let stores: ChannelStores;
vi.mock('../store', () => ({ useChannel: () => ({ channel: 'streamer', ...stores }) }));

let resolveRoom: (room: RoomInfo | null) => void;
vi.mock('../services/roomInfo', () => ({
  fetchRoomInfo: vi.fn(() => new Promise<RoomInfo | null>((resolve) => { resolveRoom = resolve; })),
}));

const room = (status: string): RoomInfo => ({ display_name: null, avatar_url: null, status, updated_at: null });

function sync(status: 'offline' | 'online' | 'live') {
  act(() => {
    stores.useChannelInfo.getState().handlePartyMessage({
      type: 'sync-full',
      requests: [],
      sources: { enabled: { donation: true } },
      channel: { status, owner: null },
    } as never);
  });
}

beforeEach(() => {
  stores = createRoomStores('streamer');
});

describe('useQueueStatus before the first sync', () => {
  it('says nothing while the socket opens and the saved status is still on its way', () => {
    stores.useChannelInfo.getState().setPartyConnectionState('connecting');
    const { result } = renderHook(() => useQueueStatus());
    expect(result.current.state).toBe('unknown');
    expect(result.current.text).toBe('');
  });

  it('shows closed at once when the queue was last saved closed', async () => {
    stores.useChannelInfo.getState().setPartyConnectionState('connecting');
    const { result } = renderHook(() => useQueueStatus());
    await act(async () => resolveRoom(room('offline')));
    expect(result.current.state).toBe('closed');

    sync('offline');
    expect(result.current.state).toBe('closed'); // never went through "connecting"
  });

  it('shows connecting when the queue was last saved open, until the server confirms', async () => {
    const { result } = renderHook(() => useQueueStatus());
    await act(async () => resolveRoom(room('live')));
    expect(result.current.state).toBe('connecting');

    sync('live');
    expect(result.current.state).toBe('open');
  });

  it('stays quiet when the saved status can\'t be fetched', async () => {
    const { result } = renderHook(() => useQueueStatus());
    await act(async () => resolveRoom(null));
    expect(result.current.state).toBe('unknown');
  });
});

describe('useQueueStatus after a sync', () => {
  it('keeps a closed queue closed while the socket reconnects', () => {
    const { result } = renderHook(() => useQueueStatus());
    sync('offline');
    act(() => {
      stores.useChannelInfo.getState().setPartyConnectionState('disconnected');
      stores.useChannelInfo.getState().setPartyConnectionState('connecting');
    });
    expect(result.current.state).toBe('closed');
  });

  it('still shows connecting for a claimed channel whose chat is not live yet', () => {
    const { result } = renderHook(() => useQueueStatus());
    sync('online');
    expect(result.current.state).toBe('connecting');
  });
});
