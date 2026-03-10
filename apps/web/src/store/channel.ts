// apps/web/src/store/channel.ts
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ConnectionState, Request, SourcesEnabled, PartyMessage, ChannelStatus } from '../types';
import { deserializeRequest, deserializeRequests } from '../types';
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
  getContext: () => { partyConnected: boolean; isOwner: boolean }
) {
  // Saved before sync-full overwrites local state; merged when ownership is (re)claimed
  let preSyncRequests: Request[] | null = null;

  return create<RequestsStore>()(
    persist(
      (set, get) => ({
        requests: [],

        add: (req) => {
          const { partyConnected, isOwner } = getContext();
          const existingRequests = get().requests;
          if (existingRequests.some(r => r.id === req.id)) return;

          set((s) => {
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

          if (partyConnected && isOwner) {
            broadcastAdd(req);
          }
        },

        update: (id, updates) => {
          const { partyConnected, isOwner } = getContext();
          set((s) => ({
            requests: s.requests.map((r) => (r.id === id ? { ...r, ...updates } : r)),
          }));
          if (partyConnected && isOwner) {
            broadcastUpdate(id, updates);
          }
        },

        toggleDone: (id) => {
          const { partyConnected, isOwner } = getContext();
          set((s) => ({
            requests: s.requests.map((r) => (r.id === id ? { ...r, done: !r.done, doneAt: !r.done ? new Date() : undefined } : r)),
          }));
          if (partyConnected && isOwner) {
            broadcastToggleDone(id);
          }
        },

        setAll: (requests) => {
          const { partyConnected, isOwner } = getContext();
          set({ requests });
          if (partyConnected && isOwner) {
            broadcastSetAll(requests);
          }
        },

        reorder: (fromId, toId) => {
          const { partyConnected, isOwner } = getContext();
          set((s) => {
            const requests = [...s.requests];
            const fromIdx = requests.findIndex(r => r.id === fromId);
            const toIdx = requests.findIndex(r => r.id === toId);
            if (fromIdx === -1 || toIdx === -1) return s;
            const [moved] = requests.splice(fromIdx, 1);
            requests.splice(toIdx, 0, moved);
            return { requests };
          });
          if (partyConnected && isOwner) {
            broadcastReorder(fromId, toId);
          }
        },

        deleteRequest: (id) => {
          const { partyConnected, isOwner } = getContext();
          set((s) => ({
            requests: s.requests.filter((r) => r.id !== id),
          }));
          if (partyConnected && isOwner) {
            broadcastDelete(id);
          }
        },

        handlePartyMessage: (msg) => {
          switch (msg.type) {
            case 'sync-full': {
              const serverRequests = deserializeRequests(msg.requests);
              const localRequests = get().requests;
              const { isOwner, partyConnected } = getContext();

              // Save local state before overwriting — will be merged if ownership is (re)claimed.
              // This handles the case where the owner made changes (toggle done, add requests)
              // during a brief PartyKit disconnect; without this, sync-full would silently
              // discard those changes because isOwner is false until ownership is re-granted.
              preSyncRequests = localRequests.length > 0 ? localRequests : null;

              // Owner seeds empty server from localStorage
              if (serverRequests.length === 0 && localRequests.length > 0 && isOwner && partyConnected) {
                const sources = getSourcesState();
                broadcastSetAll(localRequests);
                broadcastSources(sources);
              } else {
                set({ requests: serverRequests });
              }
              // Clean up localStorage - PartyKit is source of truth
              localStorage.removeItem(`dbd-requests-${channel}`);
              localStorage.removeItem(`dbd-sources-${channel}`);
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
            case 'update-request':
              set((s) => ({
                requests: s.requests.map((r) =>
                  r.id === msg.id
                    ? { ...r, ...msg.updates, timestamp: msg.updates.timestamp ? new Date(msg.updates.timestamp) : r.timestamp, doneAt: msg.updates.doneAt !== undefined ? (msg.updates.doneAt ? new Date(msg.updates.doneAt) : undefined) : r.doneAt }
                    : r
                ),
              }));
              break;
            case 'ownership-granted': {
              // After reconnect, merge any local changes made during the disconnect.
              // Only the lock-holder can mutate requests, so pre-sync local state is
              // authoritative for done flags and locally-added requests.
              if (preSyncRequests && preSyncRequests.length > 0) {
                const currentRequests = get().requests;
                const localById = new Map(preSyncRequests.map(r => [r.id, r]));
                const currentIds = new Set(currentRequests.map(r => r.id));

                let hasChanges = false;

                // Preserve local done states that diverged during disconnect
                const merged = currentRequests.map(r => {
                  const local = localById.get(r.id);
                  if (local && local.done !== r.done) {
                    hasChanges = true;
                    return { ...r, done: local.done };
                  }
                  return r;
                });

                // Re-add requests that were created locally during disconnect
                for (const r of preSyncRequests) {
                  if (!currentIds.has(r.id)) {
                    merged.push(r);
                    hasChanges = true;
                  }
                }

                if (hasChanges) {
                  set({ requests: merged });
                  broadcastSetAll(merged);
                }

                preSyncRequests = null;
              }
              break;
            }
            case 'toggle-done':
              set((s) => ({
                requests: s.requests.map((r) => (r.id === msg.id ? { ...r, done: !r.done, doneAt: !r.done ? new Date() : undefined } : r)),
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
      {
        name: `dbd-requests-${channel}`,
        partialize: (state) => ({ requests: state.requests }),
        // Read-only storage: load from localStorage for seeding, but don't persist
        // PartyKit is the source of truth after initial sync
        storage: {
          getItem: (name) => {
            const str = localStorage.getItem(name);
            if (!str) return null;
            const parsed = JSON.parse(str);
            return {
              state: {
                ...parsed.state,
                requests: (parsed.state.requests || []).map((r: any) => ({
                  ...r,
                  timestamp: new Date(r.timestamp),
                })),
              },
            };
          },
          setItem: () => { },
          removeItem: () => { },
        },
      }
    )
  );
}

// ============ SOURCES STORE ============

type SourceType = 'donation' | 'resub' | 'chat' | 'manual';
type SortMode = 'priority' | 'fifo';

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
  getContext: () => { partyConnected: boolean; isOwner: boolean }
) {
  const maybeBroadcast = (get: () => SourcesStore) => {
    const { partyConnected, isOwner } = getContext();
    if (partyConnected && isOwner) {
      const sources = get();
      broadcastSources(sources);
    }
  };

  return create<SourcesStore>()(
    persist(
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
      {
        name: `dbd-sources-${channel}`,
        // Read-only: load from localStorage for seeding, PartyKit is source of truth
        storage: {
          getItem: (name) => {
            const str = localStorage.getItem(name);
            return str ? JSON.parse(str) : null;
          },
          setItem: () => { },
          removeItem: () => { },
        },
      }
    )
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
  isOwner: boolean;
  partySynced: boolean;
  localIrcConnectionState: ConnectionState;
  localPartyConnectionState: ConnectionState;
  setIsOwner: (isOwner: boolean) => void;
  setIrcConnectionState: (state: ConnectionState) => void;
  setPartyConnectionState: (state: ConnectionState) => void;
  handlePartyMessage: (msg: PartyMessage) => void;
}

export type ChannelInfoStoreApi = ReturnType<typeof createChannelInfoStore>;

export function createChannelInfoStore() {
  return create<ChannelInfoStore>()((set, get) => ({
    status: 'offline',
    owner: null,
    isOwner: false,
    partySynced: false,
    localIrcConnectionState: 'disconnected',
    localPartyConnectionState: 'disconnected',
    setIsOwner: (isOwner) => set({ isOwner }),
    setIrcConnectionState: (state) => {
      set({ localIrcConnectionState: state });
      const { isOwner } = get();
      if (isOwner) {
        broadcastIrcStatus(state === 'connected');
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
        set({ isOwner: true });
      } else if (msg.type === 'ownership-denied') {
        set({ isOwner: false });
      } else if (msg.type === 'sync-full' || msg.type === 'update-channel') {
        const updates: Partial<ChannelInfoStore> = {
          status: msg.channel.status,
          owner: msg.channel.owner,
        };
        // Reset isOwner when channel has no owner (released or disconnected)
        if (!msg.channel.owner) {
          updates.isOwner = false;
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

  // Helper to get connection context from ChannelInfoStore
  const getContext = () => {
    const { localPartyConnectionState, isOwner } = useChannelInfo.getState();
    return {
      partyConnected: localPartyConnectionState === 'connected',
      isOwner,
    };
  };

  let useSources: SourcesStoreApi;

  const useRequests = createRequestsStore(key, () => useSources.getState(), getContext);
  useSources = createSourcesStore(key, getContext);

  return { useRequests, useSources, useChannelInfo };
}
