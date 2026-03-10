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
  needsIdentification?: boolean;
  validating?: boolean;
}

export type CharacterRequest = Request;

export interface SourcesEnabled {
  donation: boolean;
  resub: boolean;
  chat: boolean;
  manual: boolean;
}

export type ConnectionState = 'connected' | 'connecting' | 'disconnected' | 'error';
