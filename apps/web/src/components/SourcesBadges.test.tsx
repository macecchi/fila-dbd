import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { createRoomStores, type ChannelStores } from '../store/channel';
import type { RoomInfo } from '../services/roomInfo';
import { t } from '../i18n';
import { SourcesBadges } from './SourcesBadges';

let stores: ChannelStores;
vi.mock('../store', () => ({ useChannel: () => ({ channel: 'streamer', ...stores }) }));

let resolveRoom: (room: RoomInfo | null) => void;
vi.mock('../services/roomInfo', () => ({
  fetchRoomInfo: vi.fn(() => new Promise<RoomInfo | null>((resolve) => { resolveRoom = resolve; })),
}));

const labels = (container: HTMLElement) => [...container.querySelectorAll('.sources-summary')].map((e) => e.textContent);

beforeEach(() => {
  stores = createRoomStores('streamer');
});

describe('SourcesBadges', () => {
  it('says nothing before anything is known, rather than "closed" for every queue', () => {
    const { container } = render(<SourcesBadges />);
    expect(labels(container)).toEqual([]);
  });

  it('says closed early only for a queue saved closed', async () => {
    const { container } = render(<SourcesBadges />);
    await act(async () => resolveRoom({ display_name: null, avatar_url: null, status: 'offline', updated_at: null }));
    expect(labels(container)).toEqual([t('badges.queueClosed')]);
  });

  it('waits for the sync to list the sources of an open queue', async () => {
    const { container } = render(<SourcesBadges />);
    await act(async () => resolveRoom({ display_name: null, avatar_url: null, status: 'live', updated_at: null }));
    expect(labels(container)).toEqual([]);

    const sync = { type: 'sync-full', requests: [], sources: { enabled: { resub: true } }, channel: { status: 'live', owner: null } } as never;
    act(() => {
      stores.useChannelInfo.getState().handlePartyMessage(sync);
      stores.useSources.getState().handlePartyMessage(sync);
    });
    expect(labels(container)).toEqual([t('badges.resubs')]);
  });
});
