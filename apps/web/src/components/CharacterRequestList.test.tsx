import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { createRoomStores, type ChannelStores } from '../store/channel';
import type { Request } from '../types';
import { CharacterRequestList } from './CharacterRequestList';

let stores: ChannelStores;
// The card imports the context module directly, the list through the store barrel.
vi.mock('../store/ChannelContext', () => ({
  useChannel: () => ({ channel: 'streamer', ...stores, isOwnChannel: false, canEditQueue: false }),
}));
vi.mock('../store', async () => ({ useChannel: (await import('../store/ChannelContext')).useChannel }));

let nextId = 1;
function req(): Request {
  const id = nextId++;
  return {
    id,
    timestamp: new Date(),
    donor: `Donor${id}`,
    amount: '',
    amountVal: 0,
    message: 'quero a nurse',
    character: 'Nurse',
    type: 'killer',
    source: 'chat',
  };
}

const entering = (container: HTMLElement) => container.querySelectorAll('.request-card.entering').length;

// Like the party message handler: the requests and the synced flag land in one render.
function sync(requests: Request[]) {
  act(() => {
    stores.useRequests.setState({ requests });
    stores.useChannelInfo.setState({ partySynced: true });
  });
}

beforeEach(() => {
  stores = createRoomStores('streamer');
});

describe('CharacterRequestList enter animation', () => {
  it("doesn't slide in the queue the page loads with, cached or synced", () => {
    const cached = [req(), req()];
    stores.useRequests.setState({ requests: cached });
    const { container } = render(<CharacterRequestList />);
    expect(entering(container)).toBe(0);

    sync([...cached, req()]); // the server's queue has one the cache didn't
    expect(entering(container)).toBe(0);
  });

  it('slides in what arrives after the first sync', () => {
    const { container } = render(<CharacterRequestList />);
    const synced = [req()];
    sync(synced);

    act(() => {
      stores.useRequests.setState({ requests: [...synced, req()] });
    });
    expect(entering(container)).toBe(1);
  });
});
