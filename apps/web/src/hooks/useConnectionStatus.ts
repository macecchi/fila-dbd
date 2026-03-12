import { useSettings, useChannel } from '../store';

/**
 * Connection states:
 * - connected: fully operational
 * - connecting: establishing connection
 * - partial: PartyKit connected but IRC not synced to server yet
 * - disconnected: not connected
 * - error: connection failed
 */
export type ConnectionState = 'connected' | 'connecting' | 'partial' | 'disconnected' | 'error';

/** Queue only has binary state: open or closed */
export type QueueState = 'connected' | 'disconnected';

interface StatusInfo {
  connection: { state: ConnectionState; text: string };
  queue: { state: QueueState; text: string };
}

export function useConnectionStatus(): StatusInfo {
  const { isOwnChannel, useSources, useChannelInfo } = useChannel();
  const channelStatus = useChannelInfo((s) => s.status);
  const channelOwner = useChannelInfo((s) => s.owner);
  const hasLock = useChannelInfo((s) => s.hasLock);
  const localIrcConnectionState = useChannelInfo((s) => s.localIrcConnectionState);
  const localPartyConnectionState = useChannelInfo((s) => s.localPartyConnectionState);
  const enabledSources = useSources((s) => s.enabled);

  // Derive: someone else is managing (we're room owner but don't have the lock)
  const someoneElseIsOwner = isOwnChannel && !hasLock && channelOwner !== null;

  // Connection (1st dot)
  let connection: { state: ConnectionState; text: string };
  // Handle errors first
  if (localIrcConnectionState === 'error') {
    connection = { state: 'error', text: 'Erro Twitch' };
  } else if (localPartyConnectionState === 'error') {
    connection = { state: 'error', text: 'Erro servidor' };
  } else if (localPartyConnectionState === 'connecting') {
    connection = { state: 'connecting', text: 'Conectando...' };
  } else if (isOwnChannel) {
    // Owner's view
    if (someoneElseIsOwner) {
      // Another tab is managing the channel
      connection = { state: 'partial', text: 'Conectado em outra janela' };
    } else if (localIrcConnectionState === 'connecting') {
      connection = { state: 'connecting', text: 'Conectando' };
    } else if (localIrcConnectionState === 'connected' && channelStatus === 'online') {
      connection = { state: 'partial', text: 'Aguardando iniciar' };
    } else if (localIrcConnectionState === 'connected' && channelStatus === 'live') {
      connection = { state: 'connected', text: 'Conectado' };
    } else {
      connection = { state: 'disconnected', text: 'Desconectado' };
    }
  } else {
    // Viewer: state is only based on server's channel status
    if (channelStatus === 'live') {
      connection = { state: 'connected', text: 'Conectado' };
    } else if (channelStatus === 'online') {
      connection = { state: 'partial', text: `Aguardando ${channelOwner?.displayName || 'streamer'}` };
    } else {
      connection = { state: 'disconnected', text: 'Streamer offline' };
    }
  }

  // Queue (2nd dot)
  const { manual, ...autoSources } = enabledSources;
  const takingRequests = channelStatus === 'live' && Object.values(autoSources).some(Boolean);
  const queue: { state: QueueState; text: string } = takingRequests
    ? { state: 'connected', text: 'Fila aberta' }
    : { state: 'disconnected', text: 'Fila fechada' };

  return { connection, queue };
}
