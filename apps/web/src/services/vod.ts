import { tryLocalMatch } from '../data/characters';
import { parseAmount, parseDonationMessage } from '../utils/helpers';
import type { Request } from '../types';
import type { ChatMessage } from '../types';

const TWITCH_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
let vodReplayAbort: boolean | null = null;

export interface VODConfig {
  botName: string;
  minDonation: number;
  sourcesEnabled: { donation: boolean; resub: boolean; chat: boolean; manual: boolean };
}

export interface VODCallbacks {
  onStatus: (s: string) => void;
  onChat: (msg: ChatMessage) => void;
  onRequest: (request: Request) => void;
}

async function fetchGQL(query: object) {
  const opts: RequestInit = {
    method: 'POST',
    headers: { 'Client-ID': TWITCH_CLIENT_ID, 'Content-Type': 'application/json' },
    body: JSON.stringify(query)
  };
  try {
    const res = await fetch('https://gql.twitch.tv/gql', opts);
    if (!res.ok) throw new Error();
    return res.json();
  } catch {
    const proxyOpts = { ...opts, headers: { 'Content-Type': 'application/json' } };
    const res = await fetch('https://corsproxy.io/?url=' + encodeURIComponent('https://gql.twitch.tv/gql'), proxyOpts);
    return res.json();
  }
}

async function fetchVODChat(vodId: string, offset = 0) {
  return fetchGQL({
    query: `query($videoID:ID!,$contentOffsetSeconds:Int){video(id:$videoID){comments(contentOffsetSeconds:$contentOffsetSeconds,first:100){edges{node{id contentOffsetSeconds commenter{login displayName}message{fragments{text}}}}}}}`,
    variables: { videoID: vodId, contentOffsetSeconds: offset }
  });
}

export async function loadAndReplayVOD(
  vodId: string,
  speed: number,
  config: VODConfig,
  callbacks: VODCallbacks
) {
  if (!vodId) return;
  vodReplayAbort = false;
  const botName = config.botName.toLowerCase();
  let offset = 0, total = 0, donates = 0;
  const seen = new Set<string>();

  while (!vodReplayAbort) {
    const data = await fetchVODChat(vodId, offset);
    const edges = data?.data?.video?.comments?.edges || [];
    if (!edges.length) break;

    let newCount = 0, lastOffset = offset;
    for (const { node } of edges) {
      if (vodReplayAbort || seen.has(node.id)) continue;
      seen.add(node.id);
      newCount++;

      const username = node.commenter?.login?.toLowerCase() || '';
      const displayName = node.commenter?.displayName || username;
      const message = node.message?.fragments?.map((f: any) => f.text).join('') || '';
      lastOffset = node.contentOffsetSeconds || lastOffset;
      total++;

      const isDonate = username === botName;
      if (isDonate) donates++;
      callbacks.onChat({ user: displayName, message, isDonate, color: null });

      if (isDonate) {
        const parsed = parseDonationMessage(message);
        if (parsed && config.sourcesEnabled.donation) {
          const amountVal = parseAmount(parsed.amount);
          if (amountVal >= config.minDonation) {
            const local = tryLocalMatch(parsed.message);

            const request: Request = {
              id: Date.now() + Math.random(),
              timestamp: new Date(),
              donor: parsed.donor,
              amount: parsed.amount,
              amountVal,
              message: parsed.message,
              character: local?.character || 'Identificando...',
              type: local?.type || 'unknown',
              source: 'donation',
              needsIdentification: !local
            };
            callbacks.onRequest(request);
          }
        }
      }

      callbacks.onStatus(`${total} msgs, ${donates} donates`);
      if (speed > 0) await new Promise(r => setTimeout(r, speed));
    }

    if (!newCount) break;
    offset = lastOffset + 1;
  }

  if (!vodReplayAbort) callbacks.onStatus(`Done: ${total} msgs, ${donates} donates`);
  vodReplayAbort = null;
}

export function cancelVODReplay() {
  vodReplayAbort = true;
}

// ============ VOD RECOVERY ============

export interface RecoveryConfig {
  botName: string;
  minDonation: number;
  sourcesEnabled: { donation: boolean; resub: boolean; chat: boolean; manual: boolean };
  chatCommand: string;
  checkpoint?: { vodId: string; offset: number };
}

export interface RecoveryResult {
  requests: Request[];
  vodId: string;
  lastOffset: number;
}

function hashStringToNumber(s: string): number {
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) - hash) + s.charCodeAt(i);
    hash = hash & hash;
  }
  return Math.abs(hash);
}

export async function fetchCurrentVodId(channel: string): Promise<{ vodId: string; createdAt: string } | null> {
  try {
    const data = await fetchGQL({
      query: `query($login:String!){user(login:$login){videos(first:1,type:ARCHIVE,sort:TIME){edges{node{id createdAt status}}}}}`,
      variables: { login: channel }
    });

    const node = data?.data?.user?.videos?.edges?.[0]?.node;
    if (!node) return null;

    // Only recover from recent VODs (within 24 hours)
    const createdAt = new Date(node.createdAt);
    const hoursAgo = (Date.now() - createdAt.getTime()) / (1000 * 60 * 60);
    if (hoursAgo > 24) return null;

    return { vodId: node.id, createdAt: node.createdAt };
  } catch {
    return null;
  }
}

export async function recoverMissedRequests(
  channel: string,
  config: RecoveryConfig,
  existingRequests: Request[],
  onProgress?: (status: string) => void
): Promise<RecoveryResult | null> {
  onProgress?.('Buscando VOD da stream atual...');

  const vodInfo = await fetchCurrentVodId(channel);
  if (!vodInfo) return null;

  const { vodId, createdAt } = vodInfo;
  const vodStart = new Date(createdAt).getTime();
  const botName = config.botName.toLowerCase();
  const chatCommand = config.chatCommand.toLowerCase();
  const requests: Request[] = [];
  const seen = new Set<string>();

  // Resume from last checkpoint if same VOD
  const cp = config.checkpoint;
  let offset = (cp && cp.vodId === vodId) ? cp.offset + 1 : 0;

  // Build set of existing request signatures for deduplication
  const existingSignatures = new Set(
    existingRequests.map(r => `${r.donor.toLowerCase()}:${r.message.toLowerCase()}`)
  );

  onProgress?.('Analisando chat da VOD...');

  while (true) {
    const data = await fetchVODChat(vodId, offset);
    const edges = data?.data?.video?.comments?.edges || [];
    if (!edges.length) break;

    let newCount = 0, lastOffset = offset;
    for (const { node } of edges) {
      if (seen.has(node.id)) continue;
      seen.add(node.id);
      newCount++;

      const username = node.commenter?.login?.toLowerCase() || '';
      const displayName = node.commenter?.displayName || username;
      const message = node.message?.fragments?.map((f: any) => f.text).join('') || '';
      lastOffset = node.contentOffsetSeconds || lastOffset;

      const timestamp = new Date(vodStart + (node.contentOffsetSeconds || 0) * 1000);

      // Check for donations
      if (username === botName && config.sourcesEnabled.donation) {
        const parsed = parseDonationMessage(message);
        if (parsed) {
          const amountVal = parseAmount(parsed.amount);
          if (amountVal >= config.minDonation) {
            const sig = `${parsed.donor.toLowerCase()}:${parsed.message.toLowerCase()}`;
            if (!existingSignatures.has(sig)) {
              const local = tryLocalMatch(parsed.message);
              requests.push({
                id: hashStringToNumber(`vod:${node.id}`),
                timestamp,
                donor: parsed.donor,
                amount: parsed.amount,
                amountVal,
                message: parsed.message,
                character: local?.character || 'Identificando...',
                type: local?.type || 'unknown',
                source: 'donation',
                needsIdentification: !local
              });
            }
          }
        }
      }

      // Check for chat commands
      if (username !== botName && message.toLowerCase().startsWith(chatCommand) && config.sourcesEnabled.chat) {
        const requestText = message.slice(chatCommand.length).trim();
        if (requestText) {
          const sig = `${displayName.toLowerCase()}:${requestText.toLowerCase()}`;
          if (!existingSignatures.has(sig)) {
            const local = tryLocalMatch(requestText);
            requests.push({
              id: hashStringToNumber(`vod:${node.id}`),
              timestamp,
              donor: displayName,
              amount: '',
              amountVal: 0,
              message: requestText,
              character: local?.character || 'Identificando...',
              type: local?.type || 'unknown',
              source: 'chat',
              needsIdentification: !local
            });
          }
        }
      }
    }

    onProgress?.(`Analisando chat... ${seen.size} msgs, ${requests.length} pedidos encontrados`);

    if (!newCount) break;
    offset = lastOffset + 1;
  }

  return { requests, vodId, lastOffset: offset > 0 ? offset - 1 : 0 };
}
