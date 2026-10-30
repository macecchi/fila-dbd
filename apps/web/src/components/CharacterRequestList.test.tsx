import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act, fireEvent } from '@testing-library/react';
import { createRoomStores, type ChannelStores } from '../store/channel';
import type { Request } from '../types';
import { CharacterRequestList } from './CharacterRequestList';

let stores: ChannelStores;
let canEditQueue = false;
// The card imports the context module directly, the list through the store barrel.
vi.mock('../store/ChannelContext', () => ({
  useChannel: () => ({ channel: 'streamer', ...stores, isOwnChannel: false, canEditQueue }),
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
  canEditQueue = false;
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

describe('CharacterRequestList tap to select', () => {
  const selected = (container: HTMLElement) =>
    [...container.querySelectorAll<HTMLElement>('.request-card.selected')].map(c => Number(c.dataset.requestId));
  const card = (container: HTMLElement, id: number) =>
    container.querySelector<HTMLElement>(`.request-card[data-request-id="${id}"] .char-name`)!;

  it('opens one card at a time, and a second tap or a tap outside closes it', () => {
    canEditQueue = true;
    const [a, b] = [req(), req()];
    const { container } = render(<CharacterRequestList />);
    sync([a, b]);

    fireEvent.click(card(container, a.id));
    expect(selected(container)).toEqual([a.id]);

    fireEvent.pointerDown(card(container, b.id));
    fireEvent.click(card(container, b.id));
    expect(selected(container)).toEqual([b.id]);

    fireEvent.pointerDown(card(container, b.id));
    fireEvent.click(card(container, b.id));
    expect(selected(container)).toEqual([]);

    fireEvent.click(card(container, a.id));
    fireEvent.pointerDown(document.body);
    expect(selected(container)).toEqual([]);
  });

  it("doesn't open cards for viewers", () => {
    const a = req();
    const { container } = render(<CharacterRequestList />);
    sync([a]);
    fireEvent.click(card(container, a.id));
    expect(selected(container)).toEqual([]);
  });
});
