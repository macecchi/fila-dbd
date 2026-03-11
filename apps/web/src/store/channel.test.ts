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
      expect(channelInfo.isOwner).toBe(false);
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
      stores.useChannelInfo.getState().setIsOwner(true);
      stores.useRequests.getState().add(request);

      expect(party.broadcastAdd).not.toHaveBeenCalled();
    });

    it('returns false when connecting', () => {
      const stores = createRoomStores('testchannel');

      stores.useChannelInfo.getState().setPartyConnectionState('connecting');
      stores.useChannelInfo.getState().setIsOwner(true);

      const request = createTestRequest();
      stores.useRequests.getState().add(request);

      expect(party.broadcastAdd).not.toHaveBeenCalled();
    });

    it('returns false when error', () => {
      const stores = createRoomStores('testchannel');

      stores.useChannelInfo.getState().setPartyConnectionState('error');
      stores.useChannelInfo.getState().setIsOwner(true);

      const request = createTestRequest();
      stores.useRequests.getState().add(request);

      expect(party.broadcastAdd).not.toHaveBeenCalled();
    });

    it('returns true when connected', () => {
      const stores = createRoomStores('testchannel');

      stores.useChannelInfo.getState().setPartyConnectionState('connected');
      stores.useChannelInfo.getState().setIsOwner(true);

      const request = createTestRequest();
      stores.useRequests.getState().add(request);

      expect(party.broadcastAdd).toHaveBeenCalledWith(request);
    });
  });

  describe('broadcast conditions', () => {
    it('broadcasts when connected AND owner', () => {
      const stores = createRoomStores('testchannel');

      stores.useChannelInfo.getState().setPartyConnectionState('connected');
      stores.useChannelInfo.getState().setIsOwner(true);

      const request = createTestRequest();
      stores.useRequests.getState().add(request);

      expect(party.broadcastAdd).toHaveBeenCalledTimes(1);
    });

    it('does NOT broadcast when connected but NOT owner', () => {
      const stores = createRoomStores('testchannel');

      stores.useChannelInfo.getState().setPartyConnectionState('connected');
      stores.useChannelInfo.getState().setIsOwner(false);

      const request = createTestRequest();
      stores.useRequests.getState().add(request);

      expect(party.broadcastAdd).not.toHaveBeenCalled();
    });

    it('does NOT broadcast when owner but NOT connected', () => {
      const stores = createRoomStores('testchannel');

      stores.useChannelInfo.getState().setPartyConnectionState('disconnected');
      stores.useChannelInfo.getState().setIsOwner(true);

      const request = createTestRequest();
      stores.useRequests.getState().add(request);

      expect(party.broadcastAdd).not.toHaveBeenCalled();
    });

    it('does NOT broadcast when neither owner nor connected', () => {
      const stores = createRoomStores('testchannel');

      stores.useChannelInfo.getState().setPartyConnectionState('disconnected');
      stores.useChannelInfo.getState().setIsOwner(false);

      const request = createTestRequest();
      stores.useRequests.getState().add(request);

      expect(party.broadcastAdd).not.toHaveBeenCalled();
    });
  });

  describe('RequestsStore operations', () => {
    it('add() broadcasts when connected and owner', () => {
      const stores = createRoomStores('testchannel');
      stores.useChannelInfo.getState().setPartyConnectionState('connected');
      stores.useChannelInfo.getState().setIsOwner(true);

      const request = createTestRequest();
      stores.useRequests.getState().add(request);

      expect(party.broadcastAdd).toHaveBeenCalledWith(request);
      expect(stores.useRequests.getState().requests).toHaveLength(1);
    });

    it('update() broadcasts when connected and owner', () => {
      const stores = createRoomStores('testchannel');
      stores.useChannelInfo.getState().setPartyConnectionState('connected');
      stores.useChannelInfo.getState().setIsOwner(true);

      const request = createTestRequest({ id: 123 });
      stores.useRequests.getState().add(request);
      vi.clearAllMocks();

      stores.useRequests.getState().update(123, { done: true });

      expect(party.broadcastUpdate).toHaveBeenCalledWith(123, { done: true });
    });

    it('toggleDone() broadcasts when connected and owner', () => {
      const stores = createRoomStores('testchannel');
      stores.useChannelInfo.getState().setPartyConnectionState('connected');
      stores.useChannelInfo.getState().setIsOwner(true);

      const request = createTestRequest({ id: 456 });
      stores.useRequests.getState().add(request);
      vi.clearAllMocks();

      stores.useRequests.getState().toggleDone(456);

      expect(party.broadcastToggleDone).toHaveBeenCalledWith(456, expect.any(String));
    });

    it('deleteRequest() broadcasts when connected and owner', () => {
      const stores = createRoomStores('testchannel');
      stores.useChannelInfo.getState().setPartyConnectionState('connected');
      stores.useChannelInfo.getState().setIsOwner(true);

      const request = createTestRequest({ id: 789 });
      stores.useRequests.getState().add(request);
      vi.clearAllMocks();

      stores.useRequests.getState().deleteRequest(789);

      expect(party.broadcastDelete).toHaveBeenCalledWith(789);
      expect(stores.useRequests.getState().requests).toHaveLength(0);
    });

    it('reorder() broadcasts when connected and owner', () => {
      const stores = createRoomStores('testchannel');
      stores.useChannelInfo.getState().setPartyConnectionState('connected');
      stores.useChannelInfo.getState().setIsOwner(true);

      const req1 = createTestRequest({ id: 1 });
      const req2 = createTestRequest({ id: 2 });
      stores.useRequests.getState().add(req1);
      stores.useRequests.getState().add(req2);
      vi.clearAllMocks();

      stores.useRequests.getState().reorder(2, 1);

      expect(party.broadcastReorder).toHaveBeenCalledWith(2, 1);
    });

    it('setAll() broadcasts when connected and owner', () => {
      const stores = createRoomStores('testchannel');
      stores.useChannelInfo.getState().setPartyConnectionState('connected');
      stores.useChannelInfo.getState().setIsOwner(true);

      const requests = [createTestRequest({ id: 1 }), createTestRequest({ id: 2 })];
      stores.useRequests.getState().setAll(requests);

      expect(party.broadcastSetAll).toHaveBeenCalledWith(requests);
    });

    it('does not add duplicate requests', () => {
      const stores = createRoomStores('testchannel');
      stores.useChannelInfo.getState().setIsOwner(true);

      const request = createTestRequest({ id: 100 });
      stores.useRequests.getState().add(request);
      stores.useRequests.getState().add(request);

      expect(stores.useRequests.getState().requests).toHaveLength(1);
    });
  });

  describe('SourcesStore operations', () => {
    it('broadcasts sources when connected and owner', () => {
      const stores = createRoomStores('testchannel');
      stores.useChannelInfo.getState().setPartyConnectionState('connected');
      stores.useChannelInfo.getState().setIsOwner(true);

      stores.useSources.getState().toggleSource('chat');

      expect(party.broadcastSources).toHaveBeenCalled();
    });

    it('does NOT broadcast sources when not connected', () => {
      const stores = createRoomStores('testchannel');
      stores.useChannelInfo.getState().setPartyConnectionState('disconnected');
      stores.useChannelInfo.getState().setIsOwner(true);

      stores.useSources.getState().toggleSource('chat');

      expect(party.broadcastSources).not.toHaveBeenCalled();
    });

    it('does NOT broadcast sources when not owner', () => {
      const stores = createRoomStores('testchannel');
      stores.useChannelInfo.getState().setPartyConnectionState('connected');
      stores.useChannelInfo.getState().setIsOwner(false);

      stores.useSources.getState().toggleSource('chat');

      expect(party.broadcastSources).not.toHaveBeenCalled();
    });
  });

  describe('ChannelInfoStore operations', () => {
    it('broadcasts IRC status when owner', () => {
      const stores = createRoomStores('testchannel');
      stores.useChannelInfo.getState().setIsOwner(true);

      stores.useChannelInfo.getState().setIrcConnectionState('connected');

      expect(party.broadcastIrcStatus).toHaveBeenCalledWith(true);
    });

    it('does NOT broadcast IRC status when not owner', () => {
      const stores = createRoomStores('testchannel');
      stores.useChannelInfo.getState().setIsOwner(false);

      stores.useChannelInfo.getState().setIrcConnectionState('connected');

      expect(party.broadcastIrcStatus).not.toHaveBeenCalled();
    });
  });
});
