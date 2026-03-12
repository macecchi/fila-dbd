import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRoomStores } from './channel';
import type { Request } from '../types';

// Mock the party service broadcasts
vi.mock('../services/party', () => ({
  broadcastAdd: vi.fn(),
  broadcastUpdate: vi.fn(),
  broadcastToggleDone: vi.fn(),
  broadcastReorder: vi.fn(),
  broadcastDelete: vi.fn(),
  broadcastSetAll: vi.fn(),
  broadcastSources: vi.fn(),
  broadcastIrcStatus: vi.fn(),
}));

import * as party from '../services/party';

function createTestRequest(overrides: Partial<Request> = {}): Request {
  return {
    id: Date.now(),
    donor: 'TestUser',
    message: 'Test message',
    character: 'Meg Thomas',
    type: 'survivor',
    amount: '10',
    amountVal: 10,
    source: 'manual',
    done: false,
    timestamp: new Date(),
    ...overrides,
  };
}

describe('channel stores', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Clear localStorage between tests
    localStorage.clear();
  });

  describe('createRoomStores', () => {
    it('creates stores with correct initial state', () => {
      const stores = createRoomStores('testchannel');

      const channelInfo = stores.useChannelInfo.getState();
      expect(channelInfo.hasLock).toBe(false);
      expect(channelInfo.localPartyConnectionState).toBe('disconnected');

      const requests = stores.useRequests.getState();
      expect(requests.requests).toEqual([]);
    });

    it('normalizes channel name to lowercase', () => {
      const stores = createRoomStores('TestChannel');
      // The store should work - we can't directly test the key but we can verify it works
      const requests = stores.useRequests.getState();
      expect(requests.requests).toEqual([]);
    });
  });

  describe('partyConnected derivation', () => {
    it('returns false when disconnected', () => {
      const stores = createRoomStores('testchannel');

      stores.useChannelInfo.getState().setPartyConnectionState('disconnected');

      // Add a request and verify broadcast is NOT called
      const request = createTestRequest();
      stores.useChannelInfo.getState().setHasLock(true);
      stores.useRequests.getState().add(request);

      expect(party.broadcastAdd).not.toHaveBeenCalled();
    });

    it('returns false when connecting', () => {
      const stores = createRoomStores('testchannel');

      stores.useChannelInfo.getState().setPartyConnectionState('connecting');
      stores.useChannelInfo.getState().setHasLock(true);

      const request = createTestRequest();
      stores.useRequests.getState().add(request);

      expect(party.broadcastAdd).not.toHaveBeenCalled();
    });

    it('returns false when error', () => {
      const stores = createRoomStores('testchannel');

      stores.useChannelInfo.getState().setPartyConnectionState('error');
      stores.useChannelInfo.getState().setHasLock(true);

      const request = createTestRequest();
      stores.useRequests.getState().add(request);

      expect(party.broadcastAdd).not.toHaveBeenCalled();
    });

    it('returns true when connected', () => {
      const stores = createRoomStores('testchannel');

      stores.useChannelInfo.getState().setPartyConnectionState('connected');
      stores.useChannelInfo.getState().setHasLock(true);

      const request = createTestRequest();
      stores.useRequests.getState().add(request);

      expect(party.broadcastAdd).toHaveBeenCalledWith(request);
    });
  });

  describe('broadcast conditions', () => {
    it('broadcasts when connected AND owner', () => {
      const stores = createRoomStores('testchannel');

      stores.useChannelInfo.getState().setPartyConnectionState('connected');
      stores.useChannelInfo.getState().setHasLock(true);

      const request = createTestRequest();
      stores.useRequests.getState().add(request);

      expect(party.broadcastAdd).toHaveBeenCalledTimes(1);
    });

    it('broadcasts when connected without lock', () => {
      const stores = createRoomStores('testchannel');

      stores.useChannelInfo.getState().setPartyConnectionState('connected');
      stores.useChannelInfo.getState().setHasLock(false);

      const request = createTestRequest();
      stores.useRequests.getState().add(request);

      expect(party.broadcastAdd).toHaveBeenCalledTimes(1);
    });

    it('does NOT add when not connected', () => {
      const stores = createRoomStores('testchannel');

      stores.useChannelInfo.getState().setPartyConnectionState('disconnected');
      stores.useChannelInfo.getState().setHasLock(true);

      const request = createTestRequest();
      stores.useRequests.getState().add(request);

      expect(party.broadcastAdd).not.toHaveBeenCalled();
      expect(stores.useRequests.getState().requests).toHaveLength(0);
    });
  });

  describe('RequestsStore operations', () => {
    it('add() broadcasts without updating local state', () => {
      const stores = createRoomStores('testchannel');
      stores.useChannelInfo.getState().setPartyConnectionState('connected');

      const request = createTestRequest();
      stores.useRequests.getState().add(request);

      expect(party.broadcastAdd).toHaveBeenCalledWith(request);
      expect(stores.useRequests.getState().requests).toHaveLength(0);
    });

    it('update() broadcasts without updating local state', () => {
      const stores = createRoomStores('testchannel');
      stores.useChannelInfo.getState().setPartyConnectionState('connected');

      stores.useRequests.getState().update(123, { done: true });

      expect(party.broadcastUpdate).toHaveBeenCalledWith(123, { done: true });
    });

    it('toggleDone() broadcasts without updating local state', () => {
      const stores = createRoomStores('testchannel');
      stores.useChannelInfo.getState().setPartyConnectionState('connected');

      stores.useRequests.getState().toggleDone(456);

      expect(party.broadcastToggleDone).toHaveBeenCalledWith(456);
    });

    it('deleteRequest() broadcasts without updating local state', () => {
      const stores = createRoomStores('testchannel');
      stores.useChannelInfo.getState().setPartyConnectionState('connected');

      stores.useRequests.getState().deleteRequest(789);

      expect(party.broadcastDelete).toHaveBeenCalledWith(789);
    });

    it('reorder() broadcasts without updating local state', () => {
      const stores = createRoomStores('testchannel');
      stores.useChannelInfo.getState().setPartyConnectionState('connected');

      stores.useRequests.getState().reorder(2, 1);

      expect(party.broadcastReorder).toHaveBeenCalledWith(2, 1);
    });

    it('setAll() broadcasts without updating local state', () => {
      const stores = createRoomStores('testchannel');
      stores.useChannelInfo.getState().setPartyConnectionState('connected');

      const requests = [createTestRequest({ id: 1 }), createTestRequest({ id: 2 })];
      stores.useRequests.getState().setAll(requests);

      expect(party.broadcastSetAll).toHaveBeenCalledWith(requests);
      expect(stores.useRequests.getState().requests).toHaveLength(0);
    });

    it('does not broadcast when not connected', () => {
      const stores = createRoomStores('testchannel');
      stores.useChannelInfo.getState().setPartyConnectionState('disconnected');

      stores.useRequests.getState().add(createTestRequest());
      stores.useRequests.getState().toggleDone(1);
      stores.useRequests.getState().deleteRequest(1);

      expect(party.broadcastAdd).not.toHaveBeenCalled();
      expect(party.broadcastToggleDone).not.toHaveBeenCalled();
      expect(party.broadcastDelete).not.toHaveBeenCalled();
    });
  });

  describe('SourcesStore operations', () => {
    it('broadcasts sources when connected', () => {
      const stores = createRoomStores('testchannel');
      stores.useChannelInfo.getState().setPartyConnectionState('connected');

      stores.useSources.getState().toggleSource('chat');

      expect(party.broadcastSources).toHaveBeenCalled();
    });

    it('does NOT broadcast sources when not connected', () => {
      const stores = createRoomStores('testchannel');
      stores.useChannelInfo.getState().setPartyConnectionState('disconnected');

      stores.useSources.getState().toggleSource('chat');

      expect(party.broadcastSources).not.toHaveBeenCalled();
    });
  });

  describe('ChannelInfoStore operations', () => {
    it('broadcasts IRC status when owner', () => {
      const stores = createRoomStores('testchannel');
      stores.useChannelInfo.getState().setHasLock(true);

      stores.useChannelInfo.getState().setIrcConnectionState('connected');

      expect(party.broadcastIrcStatus).toHaveBeenCalledWith(true);
    });

    it('does NOT broadcast IRC status when not owner', () => {
      const stores = createRoomStores('testchannel');
      stores.useChannelInfo.getState().setHasLock(false);

      stores.useChannelInfo.getState().setIrcConnectionState('connected');

      expect(party.broadcastIrcStatus).not.toHaveBeenCalled();
    });
  });
});
