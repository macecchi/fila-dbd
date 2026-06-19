export interface Character {
  name: string;
  aliases: string[];
  portrait?: string;
}

export interface CharacterData {
  survivors: Character[];
  killers: Character[];
}

export interface Request {
  id: number;
  timestamp: Date;
  donor: string;
  amount: string;
  amountVal: number;
  message: string;
  character: string;
  type: 'survivor' | 'killer' | 'unknown' | 'none';
  done?: boolean;
  doneAt?: Date;
  source: 'donation' | 'resub' | 'chat' | 'manual';
  subTier?: number;
  isBroadcaster?: boolean;
  needsIdentification?: boolean;
  validating?: boolean;
  matchedTerm?: string;
  originMsgId?: string;
  extras?: RequestExtra[];
}

export type CharacterRequest = Request;

export interface SourcesEnabled {
  donation: boolean;
  resub: boolean;
  chat: boolean;
  manual: boolean;
}

export type ConnectionState = 'connected' | 'connecting' | 'disconnected' | 'error';

// ---------- Donation extras ----------
//
// A donation that clears `min_donation` can carry zero or more extras. Each
// extra has its own price configured per room. The first (and currently only)
// extra type is `build`: a free-text description of the loadout the donor
// wants the streamer to play, plus optional substrings of the original donor
// message that we highlight in the UI.
//
// Future extras (challenge, map offering, etc.) extend the `RequestExtraType`
// union and add a variant to `RequestExtra`. No schema migration required —
// `extras` is stored as a JSON column on D1 and as an inline field in the
// PartyKit per-request payload.

export type RequestExtraType = 'build';

export type RequestExtra =
  | { type: 'build'; text: string; matchedTerms?: string[] };

export interface ExtraConfig {
  enabled: boolean;
  price: number;
}

export interface RoomExtras {
  build?: ExtraConfig;
}

export const BUILD_DEFAULT_PRICE = 10;

export const DEFAULT_EXTRAS_CONFIG: RoomExtras = {
  build: { enabled: false, price: BUILD_DEFAULT_PRICE },
};
