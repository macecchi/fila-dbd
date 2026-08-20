import { tryLocalMatch, isWholeMessageMatch } from '../data/characters';
import { parseAmount, parseDonationMessage, isDonateBot, isLikelyTruncatedDonation } from '../utils/helpers';
import { useSettings } from '../store/settings';
import { useAuth } from '../store/auth';
import type { Request } from '../types';
import type { ChannelStores } from '../store/channel';
import { computeEntitlement, buildDonationRequests } from './donation';
import { identifyMultiple } from './llm';
import { eligibleExtras } from './extras';

export { DONATE_BOT_NAMES, isDonateBot } from '../utils/helpers';

let ws: WebSocket | null = null;
let activeStores: ChannelStores | null = null;
let intentionalClose = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_BASE_DELAY = 2000;

export function setActiveStores(stores: ChannelStores | null) {
  activeStores = stores;
}

function getStores() {
  if (!activeStores) throw new Error('No active channel stores');
  return activeStores;
}

function clearReconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  reconnectAttempts = 0;
}

export function disconnect() {
  clearReconnect();
  if (ws) {
    intentionalClose = true;
    ws.close();
    ws = null;
    activeStores?.useChannelInfo.getState().setIrcConnectionState('disconnected', false);
  }
}

export function simulateDisconnect(permanent = false) {
  if (permanent) {
    reconnectAttempts = MAX_RECONNECT_ATTEMPTS;
  }
  if (ws) {
    ws.close();
    ws = null;
  }
}

let currentChannel: string | null = null;

export function connect(channel: string) {
  const ch = channel.trim().toLowerCase();
  if (!ch) return;

  clearReconnect();
  if (ws) {
    intentionalClose = true;
    ws.close();
    ws = null;
  }
  intentionalClose = false;
  currentChannel = ch;

  const { setIrcConnectionState } = getStores().useChannelInfo.getState();
  setIrcConnectionState('connecting');
  console.log('Connecting to Twitch IRC...');

  const socket = new WebSocket('wss://irc-ws.chat.twitch.tv:443');
  ws = socket;
  socket.onopen = () => {
    socket.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
    socket.send('NICK justinfan' + Math.floor(Math.random() * 99999));
    socket.send(`JOIN #${ch}`);
  };
  socket.onmessage = (e) => {
    for (const line of e.data.split('\r\n')) {
      if (line.startsWith('PING')) socket.send('PONG :tmi.twitch.tv');
      else if (line.includes('366')) {
        reconnectAttempts = 0;
        setIrcConnectionState('connected');
        console.log('Connected to Twitch IRC');
      }
      else if (line.includes('USERNOTICE')) handleUserNotice(line);
      else if (line.includes('PRIVMSG')) handleMessage(line);
    }
  };
  socket.onclose = () => {
    ws = null;
    if (intentionalClose) {
      console.log('Disconnected from Twitch IRC');
      setIrcConnectionState('disconnected');
      intentionalClose = false;
      return;
    }
    intentionalClose = false;

    if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS && currentChannel) {
      reconnectAttempts++;
      const delay = RECONNECT_BASE_DELAY * Math.pow(2, reconnectAttempts - 1);
      console.log(`Twitch IRC disconnected, reconnecting (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}) in ${delay}ms...`);
      setIrcConnectionState('connecting');
      reconnectTimer = setTimeout(() => {
        if (currentChannel) connect(currentChannel);
      }, delay);
    } else {
      console.log('Twitch IRC disconnected, max reconnect attempts reached');
      setIrcConnectionState('error');
    }
  };
  socket.onerror = () => {
    console.log('Error connecting to Twitch IRC');
  };
}

function parseIrcTags(raw: string): Record<string, string> {
  const tags: Record<string, string> = {};
  const m = raw.match(/^@([^ ]+)/);
  if (m) m[1].split(';').forEach(p => { const [k, v] = p.split('='); tags[k] = v || ''; });
  return tags;
}

/**
 * Generate a deterministic numeric ID from the Twitch message ID.
 * This ensures multiple tabs processing the same IRC message produce the same request ID.
 * Falls back to content-based hash if no Twitch ID is available.
 */
function generateRequestId(twitchMsgId: string | undefined, fallbackContent: string): number {
  const source = twitchMsgId || fallbackContent;
  // Simple hash function to convert string to number
  let hash = 0;
  for (let i = 0; i < source.length; i++) {
    const char = source.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  // Ensure positive number and add timestamp prefix for rough ordering
  const timePrefix = Math.floor(Date.now() / 60000); // Minute-level precision
  return Math.abs(hash) + timePrefix * 1000000000;
}

function getSubTierFromBadges(badges: string): number {
  if (!badges) return 0;
  const m = badges.match(/subscriber\/(\d+)/);
  if (!m) return 0;
  const t = parseInt(m[1]);
  return t >= 3000 ? 3 : t >= 2000 ? 2 : 1;
}

function getSubTierFromUserNotice(tags: Record<string, string>): number {
  const plan = tags['msg-param-sub-plan'];
  if (plan === '3000') return 3;
  if (plan === '2000') return 2;
  if (plan === '1000' || plan === 'Prime') return 1;
  return getSubTierFromBadges(tags.badges);
}

export function handleUserNotice(raw: string) {
  const { useSources, useRequests } = getStores();
  const { enabled } = useSources.getState();
  const { add: addRequest } = useRequests.getState();

  const tags = parseIrcTags(raw);
  if (tags['msg-id'] !== 'resub' && tags['msg-id'] !== 'sub') return;
  if (!enabled.resub) return;

  const displayName = tags['display-name'] || 'unknown';
  const msgMatch = raw.match(/USERNOTICE #\w+ :(.+)$/);
  const message = msgMatch?.[1]?.trim() || '';
  if (!message) return;

  const local = tryLocalMatch(message);

  // Use Twitch message ID for deterministic deduplication across tabs
  const twitchMsgId = tags['id'];
  const fallbackContent = `resub:${displayName}:${message}`;

  const request: Request = {
    id: generateRequestId(twitchMsgId, fallbackContent),
    timestamp: new Date(),
    donor: displayName,
    amount: '',
    amountVal: 0,
    message,
    character: local?.character || 'Identificando...',
    type: local?.type || 'unknown',
    source: 'resub',
    subTier: getSubTierFromUserNotice(tags),
    needsIdentification: !isWholeMessageMatch(local, message),
    matchedTerm: local?.matchedTerm
  };
  addRequest(request);
}

function handleChatCommand(tags: Record<string, string>, displayName: string, username: string, requestText: string) {
  const { useSources, useRequests } = getStores();
  const { enabled, chatTiers } = useSources.getState();
  const { add: addRequest } = useRequests.getState();

  if (!enabled.chat) { console.log('[dbdDebug] chat source disabled'); return; }
  if (!requestText) { console.log('[dbdDebug] empty request'); return; }

  const isBroadcaster = (tags.badges?.split(',').some(b => b.startsWith('broadcaster/')) || false) || 
                        (currentChannel !== null && username === currentChannel);
  const isSub = tags.subscriber === '1' || isBroadcaster;
  const subTier = getSubTierFromBadges(tags.badges);
  const minTier = chatTiers.length > 0 ? Math.min(...chatTiers) : 1;
  if (!isSub) { console.log('[dbdDebug] not a sub'); return; }
  if (!isBroadcaster && subTier < minTier) { console.log('[dbdDebug] tier', subTier, '<', minTier); return; }

  const local = tryLocalMatch(requestText);

  // Use Twitch message ID for deterministic deduplication across tabs
  const twitchMsgId = tags['id'];
  const fallbackContent = `chat:${displayName}:${requestText}`;

  const request: Request = {
    id: generateRequestId(twitchMsgId, fallbackContent),
    timestamp: new Date(),
    donor: displayName,
    amount: '',
    amountVal: 0,
    message: requestText,
    character: local?.character || 'Identificando...',
    type: local?.type || 'unknown',
    source: 'chat',
    subTier,
    isBroadcaster,
    needsIdentification: !isWholeMessageMatch(local, requestText),
    matchedTerm: local?.matchedTerm
  };
  addRequest(request);
}

export function handleMessage(raw: string) {
  const { useSources, useRequests } = getStores();
  const { enabled, chatCommand, minDonation } = useSources.getState();
  const { add: addRequest } = useRequests.getState();

  const tags = parseIrcTags(raw);
  const userMatch = raw.match(/display-name=([^;]*)/i);
  const msgMatch = raw.match(/PRIVMSG #\w+ :(.+)$/);
  if (!userMatch || !msgMatch) return;

  const displayName = userMatch[1] || 'unknown';
  const username = displayName.toLowerCase();
  const message = msgMatch[1].trim();

  if (message.toLowerCase().startsWith(chatCommand.toLowerCase())) {
    const requestText = message.slice(chatCommand.length).trim();
    if (requestText) {
      handleChatCommand(tags, displayName, username, requestText);
    } else {
      console.log('[dbdDebug] empty request text after command');
    }
    return;
  }

  if (!isDonateBot(username)) return;
  const parsed = parseDonationMessage(message);
  if (!parsed || !enabled.donation) return;

  const amountVal = parseAmount(parsed.amount);
  if (amountVal < minDonation) return;

  // Use Twitch message ID for deterministic deduplication across tabs
  const twitchMsgId = tags['id'];
  const entitlement = computeEntitlement(amountVal, minDonation);
  const isAuthenticated = useAuth.getState().isAuthenticated;
  const timestampMs = Date.now();

  if (entitlement === 1 || !isAuthenticated) {
    // Single-request path (unchanged behavior, now with originMsgId).
    // When un-authenticated for entitlement > 1, we cannot reliably split,
    // so fall back to a single request — same UX as un-auth donations today.
    const local = tryLocalMatch(parsed.message);
    const fallbackContent = `donation:${parsed.donor}:${parsed.amount}:${parsed.message}`;
    const request: Request = {
      id: generateRequestId(twitchMsgId, fallbackContent),
      timestamp: new Date(timestampMs),
      donor: parsed.donor,
      amount: parsed.amount,
      amountVal,
      message: parsed.message,
      character: local?.character || 'Identificando...',
      type: local?.type || 'unknown',
      source: 'donation',
      needsIdentification: !isWholeMessageMatch(local, parsed.message),
      matchedTerm: local?.matchedTerm,
      originMsgId: twitchMsgId || `synthetic:${parsed.donor}:${parsed.amount}:${timestampMs}`,
    };
    addRequest(request);
    return;
  }

  // Above-min donation whose whole message is a single unambiguous character
  // (e.g. donated R$50 and just wrote "Trapper"). Nothing to split or extract —
  // build one local request and skip the LLM.
  const wholeMatch = tryLocalMatch(parsed.message);
  if (isWholeMessageMatch(wholeMatch, parsed.message)) {
    const built = buildDonationRequests({
      donor: parsed.donor,
      amount: parsed.amount,
      amountVal,
      message: parsed.message,
      twitchMsgId,
      timestampMs,
      identified: [{ character: wholeMatch!.character, type: wholeMatch!.type, matchedTerm: wholeMatch!.matchedTerm }],
    });
    for (const r of built) addRequest(r);
    return;
  }

  // Multi-request donation: always go through the LLM for accurate parsing
  // (quantifiers like "2 de X", mixed natural language).
  const extras = eligibleExtras(amountVal, useSources.getState().extrasConfig);
  identifyMultiple(parsed.message, entitlement, extras).then(characters => {
    // LivePix cuts long donor messages at 250 chars, so the request may live in
    // the lost tail. Never let the LLM's "no request" verdict hide a paid donate
    // it only saw part of — keep it in the queue as unidentified for manual review.
    if (isLikelyTruncatedDonation(parsed.message)) {
      characters = characters.map(c => c.type === 'none' ? { ...c, type: 'unknown' as const, character: '' } : c);
    }
    const built = buildDonationRequests({
      donor: parsed.donor,
      amount: parsed.amount,
      amountVal,
      message: parsed.message,
      twitchMsgId,
      timestampMs,
      identified: characters,
    });
    for (const r of built) addRequest(r);
  });
}

// Debug helpers exposed to window for DevTools testing
declare global {
  interface Window {
    dbdDebug: {
      panel: boolean;
      chat: (user: string, message: string, opts?: { sub?: boolean; tier?: number }) => void;
      donate: (donor: string, amount: number, message: string) => void;
      resub: (user: string, message: string, opts?: { tier?: number }) => void;
      raw: (ircLine: string) => void;
      review: () => void;
    };
  }
}

function checkWriteMode(): boolean {
  const connected = activeStores?.useChannelInfo.getState().localPartyConnectionState === 'connected';
  if (!connected) {
    console.warn('dbdDebug: not connected to server');
    return false;
  }
  return true;
}

window.dbdDebug = {
  panel: false,
  chat: (user: string, message: string, opts?: { sub?: boolean; tier?: number }) => {
    if (!checkWriteMode()) return;
    const sub = opts?.sub ?? true;
    const tier = opts?.tier ?? 1;
    const badge = tier === 3 ? 3000 : tier === 2 ? 2000 : 1;
    const raw = `@display-name=${user};subscriber=${sub ? 1 : 0};badges=${sub ? `subscriber/${badge}` : ''} :${user.toLowerCase()}!${user.toLowerCase()}@${user.toLowerCase()}.tmi.twitch.tv PRIVMSG #test :${message}`;
    handleMessage(raw);
  },
  donate: (donor: string, amount: number, message: string) => {
    if (!checkWriteMode()) return;
    const raw = `@display-name=livepix;color=#FF0000 :livepix!livepix@livepix.tmi.twitch.tv PRIVMSG #test :${donor} doou R$ ${amount},00: ${message}`;
    handleMessage(raw);
  },
  resub: (user: string, message: string, opts?: { tier?: number }) => {
    if (!checkWriteMode()) return;
    const tier = opts?.tier ?? 1;
    const plan = tier === 3 ? '3000' : tier === 2 ? '2000' : '1000';
    const raw = `@display-name=${user};msg-id=resub;msg-param-sub-plan=${plan} :tmi.twitch.tv USERNOTICE #test :${message}`;
    handleUserNotice(raw);
  },
  raw: (ircLine: string) => {
    if (!checkWriteMode()) return;
    if (ircLine.includes('USERNOTICE')) handleUserNotice(ircLine);
    else if (ircLine.includes('PRIVMSG')) handleMessage(ircLine);
  },
  review: () => window.dispatchEvent(new CustomEvent('dbd:open-review')),
};
