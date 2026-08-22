import type { Request, SourcesEnabled, RequestExtra, RoomExtras } from './types';

// Bump on non-backwards-compatible changes to PartyMessage formats or connection logic
export const PROTOCOL_VERSION = 1;
export const MAX_PENDING_REQUESTS = 99;

export interface SourcesSettings {
  enabled: SourcesEnabled;
  chatCommand: string;
  chatTiers: number[];
  priority: ('donation' | 'resub' | 'chat' | 'manual')[];
  sortMode: 'priority' | 'fifo';
  minDonation: number;
  hideNonRequests?: boolean;
  confirmInChat?: boolean;
  extrasConfig?: RoomExtras;
  recoveryVodId?: string;
  recoveryVodOffset?: number;
  prioritizeTiers?: boolean;
  prioritizeDonations?: boolean;
}

export type ChannelStatus = 'offline' | 'online' | 'live';

export interface ChannelState {
  status: ChannelStatus;
  owner: { login: string; displayName: string; avatar: string } | null;
  /**
   * The room is ownerless because the streamer closed the queue, not because a socket
   * died. Sessions auto-reclaim a room that merely went quiet; they leave this one alone
   * until the streamer opens it again. Optional: older clients simply ignore it.
   */
  closedByOwner?: boolean;
}

export interface SerializedRequest {
  id: number;
  timestamp: string;
  donor: string;
  amount: string;
  amountVal: number;
  message: string;
  character: string;
  type: 'survivor' | 'killer' | 'unknown' | 'none';
  done?: boolean;
  doneAt?: string;
  source: 'donation' | 'resub' | 'chat' | 'manual';
  subTier?: number;
  isBroadcaster?: boolean;
  needsIdentification?: boolean;
  validating?: boolean;
  matchedTerm?: string;
  extras?: RequestExtra[];
}

export type PartyMessage =
  | { type: 'sync-full'; requests: SerializedRequest[]; sources: SourcesSettings; channel: ChannelState }
  | { type: 'add-request'; request: SerializedRequest }
  | { type: 'update-request'; id: number; updates: Partial<SerializedRequest> }
  | { type: 'toggle-done'; id: number; done: boolean; doneAt?: string }
  | { type: 'reorder'; fromId: number; toId: number; opId?: string }
  | { type: 'delete-request'; id: number }
  | { type: 'set-all'; requests: SerializedRequest[] }
  | { type: 'update-sources'; sources: SourcesSettings }
  | { type: 'update-channel'; channel: ChannelState }
  | { type: 'irc-status'; connected: boolean }
  | { type: 'claim-ownership' }
  | { type: 'release-ownership' }
  | { type: 'ownership-granted' }
  | { type: 'ownership-denied'; currentOwner: string }
  | { type: 'server-error'; code: string; message: string; id?: number };

export function serializeRequest(req: Request): SerializedRequest {
  return {
    ...req,
    timestamp: req.timestamp.toISOString(),
    doneAt: req.doneAt?.toISOString(),
  };
}

export function deserializeRequest(req: SerializedRequest): Request {
  return {
    ...req,
    timestamp: new Date(req.timestamp),
    doneAt: req.doneAt ? new Date(req.doneAt) : undefined,
  };
}

export function deserializeRequests(requests: SerializedRequest[]): Request[] {
  return requests.map(deserializeRequest);
}

export function normalizeSourcesSettings(sources: any): SourcesSettings {
  if (!sources) {
    return {
      enabled: { donation: true, chat: true, resub: false, manual: true },
      chatCommand: '!fila',
      chatTiers: [2, 3],
      priority: ['donation', 'chat', 'resub', 'manual'],
      sortMode: 'fifo',
      minDonation: 5,
      hideNonRequests: true,
      confirmInChat: false,
      prioritizeTiers: false,
      prioritizeDonations: false,
    };
  }

  const enabled = sources.enabled || {};
  return {
    enabled: {
      donation: enabled.donation === true || enabled.donation === 1 || enabled.donation === 'true',
      chat: enabled.chat === true || enabled.chat === 1 || enabled.chat === 'true',
      resub: enabled.resub === true || enabled.resub === 1 || enabled.resub === 'true',
      manual: enabled.manual === true || enabled.manual === 1 || enabled.manual === 'true',
    },
    chatCommand: typeof sources.chatCommand === 'string' ? sources.chatCommand : '!fila',
    chatTiers: Array.isArray(sources.chatTiers) ? sources.chatTiers.map(Number) : [2, 3],
    priority: Array.isArray(sources.priority) ? sources.priority : ['donation', 'chat', 'resub', 'manual'],
    sortMode: sources.sortMode === 'priority' ? 'priority' : 'fifo',
    minDonation: typeof sources.minDonation === 'number' ? sources.minDonation : 5,
    hideNonRequests: sources.hideNonRequests === undefined ? true : (sources.hideNonRequests === true || sources.hideNonRequests === 1 || sources.hideNonRequests === 'true'),
    confirmInChat: sources.confirmInChat === true || sources.confirmInChat === 1 || sources.confirmInChat === 'true',
    prioritizeTiers: sources.prioritizeTiers === true || sources.prioritizeTiers === 1 || sources.prioritizeTiers === 'true',
    prioritizeDonations: sources.prioritizeDonations === true || sources.prioritizeDonations === 1 || sources.prioritizeDonations === 'true',
    extrasConfig: sources.extrasConfig ? {
      build: sources.extrasConfig.build ? {
        enabled: sources.extrasConfig.build.enabled === true || sources.extrasConfig.build.enabled === 1 || sources.extrasConfig.build.enabled === 'true',
        price: typeof sources.extrasConfig.build.price === 'number' ? sources.extrasConfig.build.price : 10,
      } : undefined
    } : undefined,
    recoveryVodId: sources.recoveryVodId,
    recoveryVodOffset: sources.recoveryVodOffset,
  };
}

export function compareRequests(
  a: { done?: boolean; source: string; subTier?: number; amountVal?: number; timestamp: Date | string },
  b: { done?: boolean; source: string; subTier?: number; amountVal?: number; timestamp: Date | string },
  priority?: string[],
  prioritizeTiers?: boolean,
  prioritizeDonations?: boolean
): number {
  if (a.done && !b.done) return 1;
  if (!a.done && b.done) return -1;

  const actualPriority = priority || ['donation', 'chat', 'resub', 'manual'];
  const aPri = actualPriority.indexOf(a.source);
  const bPri = actualPriority.indexOf(b.source);
  if (aPri !== bPri) return aPri - bPri;

  if (a.source === 'chat' || a.source === 'resub') {
    if (prioritizeTiers) {
      const aTier = a.subTier || 1;
      const bTier = b.subTier || 1;
      if (aTier !== bTier) return bTier - aTier;
    }
  } else if (a.source === 'donation') {
    if (prioritizeDonations) {
      const aAmt = a.amountVal ?? 0;
      const bAmt = b.amountVal ?? 0;
      if (aAmt !== bAmt) return bAmt - aAmt;
    }
  }

  const aTime = typeof a.timestamp === 'string' ? new Date(a.timestamp).getTime() : a.timestamp.getTime();
  const bTime = typeof b.timestamp === 'string' ? new Date(b.timestamp).getTime() : b.timestamp.getTime();
  return aTime - bTime;
}

