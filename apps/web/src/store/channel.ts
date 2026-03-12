// apps/web/src/store/channel.ts
import { create } from 'zustand';
import { MAX_PENDING_REQUESTS } from '@dbd-utils/shared';
import type { ConnectionState, Request, SourcesEnabled, PartyMessage, ChannelStatus } from '../types';
import { deserializeRequest, deserializeRequests } from '../types';
import { useToasts } from './toasts';
import {
  broadcastAdd,
  broadcastUpdate,
  broadcastToggleDone,
  broadcastReorder,
  broadcastDelete,
  broadcastSetAll,
  broadcastSources,
  broadcastIrcStatus,
} from '../services/party';

// ============ REQUESTS STORE ============

function requireParty(getContext: () => { partyConnected: boolean }): boolean {
  if (getContext().partyConnected) return true;
  useToasts.getState().show('Sem conexão com o servidor. Tente novamente.', 'Erro');
  return false;
}

interface RequestsStore {
  requests: Request[];
  add: (req: Request) => void;
  update: (id: number, updates: Partial<Request>) => void;
  toggleDone: (id: number) => void;
  setAll: (requests: Request[]) => void;
  reorder: (fromId: number, toId: number) => void;
  deleteRequest: (id: number) => void;
  handlePartyMessage: (msg: PartyMessage) => void;
}

export type RequestsStoreApi = ReturnType<typeof createRequestsStore>;

export function createRequestsStore(
  channel: string,
  getSourcesState: () => SourcesStore,
  getContext: () => { partyConnected: boolean }
) {
  return create<RequestsStore>()(
      (set, get) => ({
        requests: [],

        add: (req) => {
          if (!requireParty(getContext)) return;
          broadcastAdd(req);
        },

        update: (id, updates) => {
          if (!requireParty(getContext)) return;
          broadcastUpdate(id, updates);
        },

        toggleDone: (id) => {
          if (!requireParty(getContext)) return;
          const req = get().requests.find(r => r.id === id);
          if (!req) return;
          broadcastToggleDone(id, !req.done);
        },

        setAll: (requests) => {
          if (!requireParty(getContext)) return;
          broadcastSetAll(requests);
        },

        reorder: (fromId, toId) => {
          if (!requireParty(getContext)) return;
          broadcastReorder(fromId, toId);
        },

        deleteRequest: (id) => {
          if (!requireParty(getContext)) return;
          broadcastDelete(id);
        },

        handlePartyMessage: (msg) => {
          switch (msg.type) {
            case 'sync-full': {
              set({ requests: deserializeRequests(msg.requests) });
              break;
            }
            case 'add-request': {
              const req = deserializeRequest(msg.request);
              set((s) => {
                if (s.requests.some(r => r.id === req.id)) return s;
                const { sortMode, priority } = getSourcesState();
                if (sortMode === 'fifo') {
                  return { requests: [...s.requests, req] };
                }
                const requests = [...s.requests];
                const reqPri = priority.indexOf(req.source);
                let insertIdx = requests.length;
                for (let i = 0; i < requests.length; i++) {
                  if (requests[i].done) continue;
                  const iPri = priority.indexOf(requests[i].source);
                  if (iPri > reqPri || (iPri === reqPri && requests[i].timestamp > req.timestamp)) {
                    insertIdx = i;
                    break;
                  }
                }
                requests.splice(insertIdx, 0, req);
                return { requests };
              });
              break;
            }
            case 'update-request': {
              const { timestamp, doneAt, ...rest } = msg.updates;
              set((s) => ({
                requests: s.requests.map((r) => {
                  if (r.id !== msg.id) return r;
                  return {
                    ...r,
                    ...rest,
                    timestamp: 'timestamp' in msg.updates
                      ? (timestamp ? new Date(timestamp) : r.timestamp)
                      : r.timestamp,
                    doneAt: 'doneAt' in msg.updates
                      ? (doneAt ? new Date(doneAt) : undefined)
                      : r.doneAt,
                  };
                }),
              }));
              break;
            }
            case 'ownership-granted':
            case 'ownership-denied':
              break;
            case 'toggle-done':
              set((s) => ({
                requests: s.requests.map((r) => (r.id === msg.id
                  ? { ...r, done: msg.done, doneAt: msg.done ? (msg.doneAt ? new Date(msg.doneAt) : new Date()) : undefined }
                  : r)),
              }));
              break;
            case 'reorder':
              set((s) => {
                const requests = [...s.requests];
                const fromIdx = requests.findIndex(r => r.id === msg.fromId);
                const toIdx = requests.findIndex(r => r.id === msg.toId);
                if (fromIdx === -1 || toIdx === -1) return s;
                const [moved] = requests.splice(fromIdx, 1);
                requests.splice(toIdx, 0, moved);
                return { requests };
              });
              break;
            case 'delete-request':
              set((s) => ({
                requests: s.requests.filter((r) => r.id !== msg.id),
              }));
              break;
            case 'set-all':
              set({ requests: deserializeRequests(msg.requests) });
              break;
          }
        },
      }),
  );
}

// ============ SOURCES STORE ============

export type SourceType = 'donation' | 'resub' | 'chat' | 'manual';
export type SortMode = 'priority' | 'fifo';

interface SourcesStore {
  enabled: SourcesEnabled;
  chatCommand: string;
  chatTiers: number[];
  priority: SourceType[];
  sortMode: SortMode;
  minDonation: number;
  recoveryVodId?: string;
  recoveryVodOffset?: number;
  setEnabled: (enabled: SourcesEnabled) => void;
  toggleSource: (source: keyof SourcesEnabled) => void;
  setChatCommand: (cmd: string) => void;
  setChatTiers: (tiers: number[]) => void;
  setPriority: (priority: SourceType[]) => void;
  setSortMode: (mode: SortMode) => void;
  setMinDonation: (min: number) => void;
  setRecoveryCheckpoint: (vodId: string, offset: number) => void;
  handlePartyMessage: (msg: PartyMessage) => void;
}

export type SourcesStoreApi = ReturnType<typeof createSourcesStore>;

export const SOURCES_DEFAULTS = {
  enabled: {
    donation: true,
    chat: true,
    resub: false,
    manual: true,
  },
  chatCommand: '!fila',
  chatTiers: [2, 3],
  priority: ['donation', 'chat', 'resub', 'manual'] as SourceType[],
  sortMode: 'fifo' as SortMode,
  minDonation: 5,
};


export function createSourcesStore(
  channel: string,
  getContext: () => { partyConnected: boolean }
) {
  const maybeBroadcast = (get: () => SourcesStore) => {
    if (getContext().partyConnected) {
      broadcastSources(get());
    }
  };

  return create<SourcesStore>()(
      (set, get) => ({
        enabled: SOURCES_DEFAULTS.enabled,
        chatCommand: SOURCES_DEFAULTS.chatCommand,
        chatTiers: SOURCES_DEFAULTS.chatTiers,
        priority: SOURCES_DEFAULTS.priority,
        sortMode: SOURCES_DEFAULTS.sortMode,
        minDonation: SOURCES_DEFAULTS.minDonation,
        setEnabled: (enabled) => {
          set({ enabled });
          maybeBroadcast(get);
        },
        toggleSource: (source) => {
          set((s) => ({ enabled: { ...s.enabled, [source]: !s.enabled[source] } }));
          maybeBroadcast(get);
        },
        setChatCommand: (chatCommand) => {
          set({ chatCommand });
          maybeBroadcast(get);
        },
        setChatTiers: (chatTiers) => {
          set({ chatTiers });
          maybeBroadcast(get);
        },
        setPriority: (priority) => {
          set({ priority });
          maybeBroadcast(get);
        },
        setSortMode: (sortMode) => {
          set({ sortMode });
          maybeBroadcast(get);
        },
        setMinDonation: (minDonation) => {
          set({ minDonation });
          maybeBroadcast(get);
        },
        setRecoveryCheckpoint: (recoveryVodId, recoveryVodOffset) => {
          set({ recoveryVodId, recoveryVodOffset });
          maybeBroadcast(get);
        },
        handlePartyMessage: (msg) => {
          if (msg.type === 'sync-full' || msg.type === 'update-sources') {
            const sources = msg.sources;
            set({
              enabled: sources.enabled,
              chatCommand: sources.chatCommand,
              chatTiers: sources.chatTiers,
              priority: sources.priority,
              sortMode: sources.sortMode,
              minDonation: sources.minDonation,
              recoveryVodId: sources.recoveryVodId,
              recoveryVodOffset: sources.recoveryVodOffset,
            });
          }
        },
      }),
  );
}

// ============ CHANNEL INFO STORE ============

interface ChannelOwner {
  login: string;
  displayName: string;
  avatar: string;
}

interface ChannelInfoStore {
  status: ChannelStatus;
  owner: ChannelOwner | null;
  hasLock: boolean;
  partySynced: boolean;
  localIrcConnectionState: ConnectionState;
  localPartyConnectionState: ConnectionState;
  setHasLock: (hasLock: boolean) => void;
  setIrcConnectionState: (state: ConnectionState, broadcast?: boolean) => void;
  setPartyConnectionState: (state: ConnectionState) => void;
  handlePartyMessage: (msg: PartyMessage) => void;
}

export type ChannelInfoStoreApi = ReturnType<typeof createChannelInfoStore>;

export function createChannelInfoStore() {
  return create<ChannelInfoStore>()((set, get) => ({
    status: 'offline',
    owner: null,
    hasLock: false,
    partySynced: false,
    localIrcConnectionState: 'disconnected',
    localPartyConnectionState: 'disconnected',
    setHasLock: (hasLock) => set({ hasLock }),
    setIrcConnectionState: (state, broadcast = true) => {
      set({ localIrcConnectionState: state });
      if (broadcast) {
        const { hasLock } = get();
        if (hasLock) {
          broadcastIrcStatus(state === 'connected');
        }
      }
    },
    setPartyConnectionState: (state) => {
      set({ localPartyConnectionState: state });
      if (state === 'disconnected') {
        set({ partySynced: false });
      }
    },
    handlePartyMessage: (msg) => {
      if (msg.type === 'sync-full') {
        set({ partySynced: true });
      }
      if (msg.type === 'ownership-granted') {
        set({ hasLock: true });
      } else if (msg.type === 'ownership-denied') {
        set({ hasLock: false });
      } else if (msg.type === 'sync-full' || msg.type === 'update-channel') {
        const updates: Partial<ChannelInfoStore> = {
          status: msg.channel.status,
          owner: msg.channel.owner,
        };
        // Reset hasLock when channel has no owner (released or disconnected)
        if (!msg.channel.owner) {
          updates.hasLock = false;
        }
        set(updates);
      }
    },
  }));
}

// ============ CHANNEL STORES ============

export interface ChannelStores {
  useRequests: RequestsStoreApi;
  useSources: SourcesStoreApi;
  useChannelInfo: ChannelInfoStoreApi;
}

// Given a room name, initialize all the stores for that room
export function createRoomStores(channel: string): ChannelStores {
  const key = channel.toLowerCase();

  // ChannelInfoStore is created first - it has no dependencies
  const useChannelInfo = createChannelInfoStore();

  const getContext = () => ({
    partyConnected: useChannelInfo.getState().localPartyConnectionState === 'connected',
  });

  let useSources: SourcesStoreApi;

  const useRequests = createRequestsStore(key, () => useSources.getState(), getContext);
  useSources = createSourcesStore(key, getContext);

  return { useRequests, useSources, useChannelInfo };
}
