// apps/web/src/store/ChannelContext.tsx
import { createContext, useContext, useMemo, useEffect, useRef } from 'react';
import { createRoomStores, type ChannelStores } from './channel';
import { setActiveStores, connect as connectIrc, disconnect as disconnectIrc } from '../services/twitch';
import { connectParty, disconnectParty, broadcastIrcStatus, claimOwnership } from '../services/party';
import { useAuth } from './auth';
import { toast } from 'sonner';
import { t } from '../i18n';

// Persisted opt-out for the "notifications blocked" warning toast: once the user
// dismisses it, we never show it again (per browser).
const NOTIF_TOAST_DISMISSED_KEY = 'fila-dbd-notif-toast-dismissed-v1';

function isNotifToastDismissed(): boolean {
  try {
    return localStorage.getItem(NOTIF_TOAST_DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

function setNotifToastDismissed() {
  try {
    localStorage.setItem(NOTIF_TOAST_DISMISSED_KEY, '1');
  } catch {
    // ignore (private mode / storage full)
  }
}

function sendPushNotification(title: string, body: string) {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'granted') {
    new Notification(title, { body, tag: 'dbd-disconnect' });
  } else {
    console.log(`[push] permission=${Notification.permission}, skipped: ${title}`);
  }
}

interface ChannelContextValue extends ChannelStores {
  channel: string;
  isOwnChannel: boolean;
  canControlConnection: boolean;
}

const ChannelContext = createContext<ChannelContextValue | null>(null);

interface ChannelProviderProps {
  channel: string;
  children: React.ReactNode;
}

export function ChannelProvider({ channel, children }: ChannelProviderProps) {
  const { user, isAuthenticated, getAccessToken } = useAuth();
  const isOwnChannel = (import.meta.env.DEV && isAuthenticated && !!user) || (isAuthenticated && !!user && channel.toLowerCase() === user.login.toLowerCase());
  const stores = useMemo(() => createRoomStores(channel), [channel]);

  useEffect(() => {
    setActiveStores(stores);
    return () => setActiveStores(null);
  }, [stores]);

  // Subscribe to ownership state
  const hasLock = stores.useChannelInfo((s) => s.hasLock);
  const owner = stores.useChannelInfo((s) => s.owner);
  const localIrcState = stores.useChannelInfo((s) => s.localIrcConnectionState);
  const partyConnected = stores.useChannelInfo((s) => s.localPartyConnectionState) === 'connected';
  // Derive: someone else is managing (we're room owner but don't have the lock)
  const someoneElseIsOwner = isOwnChannel && !hasLock && owner !== null;

  // Last broadcast sources signature — used to skip the "queue settings updated"
  // toast when an update-sources message carries no meaningful change (e.g. the user
  // blurs an EditableField without editing, which still re-dispatches the value).
  const lastSourcesSignature = useRef<string | null>(null);

  // Auto-claim ownership once on initial connect if no one owns the channel
  const hasTriedAutoClaim = useRef(false);
  useEffect(() => {
    if (isOwnChannel && partyConnected && !hasTriedAutoClaim.current) {
      hasTriedAutoClaim.current = true;
      if (!owner && !hasLock) {
        claimOwnership();
      }
    }
  }, [isOwnChannel, partyConnected, owner, hasLock]);

  // Auto-connect to IRC once when ownership is first granted
  const hasAutoConnectedIrc = useRef(false);
  useEffect(() => {
    if (hasLock && !hasAutoConnectedIrc.current) {
      hasAutoConnectedIrc.current = true;
      if (localIrcState === 'disconnected') {
        connectIrc(channel);
      }
    }
    // Reset when ownership is lost so next grant auto-connects again
    if (!hasLock) {
      hasAutoConnectedIrc.current = false;
    }
  }, [hasLock, localIrcState, channel]);

  // Cleanup IRC when we lose ownership
  useEffect(() => {
    if (someoneElseIsOwner) {
      disconnectIrc();
    }
    return () => disconnectIrc();
  }, [someoneElseIsOwner]);

  // Show toast when someone else takes ownership
  const prevSomeoneElseIsOwner = useRef(false);
  useEffect(() => {
    if (someoneElseIsOwner && !prevSomeoneElseIsOwner.current) {
      toast.warning(t('toast.channelAlreadyOpen'), {
        description: t('toast.channelAlreadyOpenDesc'),
        duration: 10000,
      });
    }
    prevSomeoneElseIsOwner.current = someoneElseIsOwner;
  }, [someoneElseIsOwner]);

  // Request notification permission + show toast if denied (reactive to permission changes)
  const notifToastId = useRef<string | number | null>(null);
  useEffect(() => {
    if (!isOwnChannel || !('Notification' in window)) return;

    // Distinguishes our own toast.dismiss() calls (permission granted / unmount)
    // from a real user dismissal, since sonner fires onDismiss for both. Stays set
    // until the next toast is created — onDismiss runs async, after this returns.
    let dismissingSelf = false;
    const dismissSelf = () => {
      if (notifToastId.current === null) return;
      dismissingSelf = true;
      toast.dismiss(notifToastId.current);
      notifToastId.current = null;
    };

    const handlePermission = (state: string) => {
      if (state === 'default') {
        Notification.requestPermission();
      } else if (state === 'denied') {
        if (notifToastId.current === null && !isNotifToastDismissed()) {
          dismissingSelf = false;
          notifToastId.current = toast.warning(t('toast.notificationsBlocked'), {
            description: t('toast.notificationsBlockedDesc'),
            duration: Infinity,
            onDismiss: () => {
              if (dismissingSelf) return;
              notifToastId.current = null;
              setNotifToastDismissed();
            },
          });
        }
      } else if (state === 'granted') {
        dismissSelf();
      }
    };

    handlePermission(Notification.permission);

    let permStatus: PermissionStatus | null = null;
    const onChange = () => {
      if (permStatus) handlePermission(permStatus.state);
    };

    if ('permissions' in navigator) {
      navigator.permissions.query({ name: 'notifications' }).then((status) => {
        permStatus = status;
        status.addEventListener('change', onChange);
      });
    }

    return () => {
      permStatus?.removeEventListener('change', onChange);
      dismissSelf();
    };
  }, [isOwnChannel]);

  // Toast + push notification on disconnect (only for channel owner)
  const prevIrcState = useRef(localIrcState);
  const prevPartyState = useRef(partyConnected);
  const ircEverConnected = useRef(false);
  const partyEverConnected = useRef(false);
  const partyPushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const PARTY_PUSH_DELAY = 30_000; // only push after 30s disconnected

  useEffect(() => {
    if (!isOwnChannel) {
      prevIrcState.current = localIrcState;
      prevPartyState.current = partyConnected;
      return;
    }

    const wasIrcConnected = prevIrcState.current === 'connected';

    // IRC: connected → connecting (auto-reconnecting)
    if (wasIrcConnected && localIrcState === 'connecting') {
      toast.warning(t('toast.twitchIrc'), { id: 'irc-status', description: t('toast.ircReconnecting') });
    }

    // IRC: connected/connecting → error (retries exhausted)
    if (wasIrcConnected && localIrcState === 'error') {
      toast.error(t('toast.twitchIrc'), { id: 'irc-status', description: t('toast.ircLost'), duration: Infinity });
      sendPushNotification(
        t('push.connectionLost'),
        t('push.ircLost'),
      );
    }

    // IRC: reconnected successfully (not initial connect)
    if (prevIrcState.current === 'connecting' && localIrcState === 'connected' && ircEverConnected.current) {
      toast.success(t('toast.twitchIrc'), { id: 'irc-status', description: t('toast.ircReconnected') });
    }
    if (localIrcState === 'connected') ircEverConnected.current = true;

    // PartyKit: disconnected — toast immediately, push after delay
    if (prevPartyState.current && !partyConnected) {
      toast.warning(t('toast.server'), { id: 'party-status', description: t('toast.serverReconnecting') });
      if (!partyPushTimer.current) {
        partyPushTimer.current = setTimeout(() => {
          partyPushTimer.current = null;
          sendPushNotification(
            t('push.connectionLost'),
            t('push.serverLost'),
          );
        }, PARTY_PUSH_DELAY);
      }
    }

    // PartyKit: reconnected — cancel pending push, show toast (not initial connect)
    if (!prevPartyState.current && partyConnected) {
      if (partyPushTimer.current) {
        clearTimeout(partyPushTimer.current);
        partyPushTimer.current = null;
      }
      if (partyEverConnected.current) {
        toast.success(t('toast.server'), { id: 'party-status', description: t('toast.serverReconnected') });
      }
    }
    if (partyConnected) partyEverConnected.current = true;

    prevIrcState.current = localIrcState;
    prevPartyState.current = partyConnected;
  }, [localIrcState, partyConnected, isOwnChannel]);

  // Cleanup party push timer on unmount
  useEffect(() => {
    return () => {
      if (partyPushTimer.current) {
        clearTimeout(partyPushTimer.current);
        partyPushTimer.current = null;
      }
    };
  }, []);

  // Connect to PartySocket
  useEffect(() => {
    const { handlePartyMessage: handleRequestsMessage } = stores.useRequests.getState();
    const { handlePartyMessage: handleSourcesMessage } = stores.useSources.getState();
    const { handlePartyMessage: handleChannelInfoMessage, setPartyConnectionState } = stores.useChannelInfo.getState();

    let cancelled = false;

    async function connect() {
      const token = await getAccessToken();
      if (cancelled) return;

      console.log('Connecting to PartyKit...');
      setPartyConnectionState('connecting');
      connectParty(
        channel,
        token,
        (msg) => {
          if (msg.type === 'server-error') {
            console.error(`[server-error] ${msg.code}: ${msg.message}`);
            // Let the requests store roll back an optimistic add the server rejected.
            handleRequestsMessage(msg);
            if (msg.code === 'version_mismatch') {
              disconnectParty();
              toast.warning(t('toast.newVersionAvailable'), {
                id: 'new-version',
                description: t('toast.newVersionUpdate'),
                duration: Infinity,
                action: { label: t('toast.updateAction'), onClick: () => window.__triggerSWUpdate ? window.__triggerSWUpdate() : location.reload() },
              });
              sendPushNotification(t('push.newVersionTitle'), t('push.newVersion'));
              return;
            }
            toast.error(t('toast.serverError'), {
              id: 'party-status',
              description: msg.message,
              duration: Infinity,
            });
            return;
          }
          if (msg.type === 'update-sources' && isOwnChannel) {
            const s = msg.sources;
            const signature = JSON.stringify({
              enabled: s.enabled,
              minDonation: s.minDonation,
              chatCommand: s.chatCommand,
              chatTiers: [...s.chatTiers].sort(),
            });
            const isFirstSignature = lastSourcesSignature.current === null;
            const changed = lastSourcesSignature.current !== signature;
            lastSourcesSignature.current = signature;
            if (!changed || isFirstSignature) {
              handleRequestsMessage(msg);
              handleSourcesMessage(msg);
              handleChannelInfoMessage(msg);
              return;
            }
            const parts: string[] = [];
            if (s.enabled.donation) parts.push(t('toast.sourcesDonations', { amount: String(s.minDonation) }));
            if (s.enabled.chat) {
              const minTier = s.chatTiers.length ? Math.min(...s.chatTiers) : 1;
              parts.push(t('toast.sourcesChat', { command: s.chatCommand, tier: String(minTier) }));
            }
            if (s.enabled.resub) parts.push(t('toast.sourcesResubs'));
            let description: string;
            if (parts.length === 0) {
              description = t('toast.sourcesNoneActive');
            } else if (parts.length === 1) {
              description = t('toast.sourcesAccepting', { sources: parts[0] });
            } else {
              const last = parts.pop()!;
              description = t('toast.sourcesAccepting', { sources: `${parts.join(', ')} ${t('toast.sourcesAnd')} ${last}` });
            }
            toast.info(t('toast.sourcesUpdated'), { id: 'sources-updated', description });
          }
          handleRequestsMessage(msg);
          handleSourcesMessage(msg);
          handleChannelInfoMessage(msg);
        },
        () => {
          console.log('Connected to PartyKit');
          setPartyConnectionState('connected');
          // Re-send IRC status in case IRC connected before PartySocket
          const { localIrcConnectionState, hasLock } = stores.useChannelInfo.getState();
          if (hasLock && localIrcConnectionState === 'connected') {
            broadcastIrcStatus(true);
          }
        },
        () => {
          console.log('Disconnected from PartyKit');
          setPartyConnectionState('disconnected');
        },
        () => {
          console.log('Error connecting to PartyKit');
          setPartyConnectionState('error');
        }
      );
    }

    connect();

    return () => {
      cancelled = true;
      disconnectParty();
      setPartyConnectionState('disconnected');
    };
  }, [channel, isOwnChannel, stores, getAccessToken]);

  // canControlConnection: own channel + no other tab holds the lock
  const canControlConnection = isOwnChannel && !someoneElseIsOwner;

  const value = useMemo(
    () => ({ channel, isOwnChannel, canControlConnection, ...stores }),
    [channel, isOwnChannel, canControlConnection, stores]
  );

  return (
    <ChannelContext.Provider value={value}>
      {children}
    </ChannelContext.Provider>
  );
}

export function useChannel(): ChannelContextValue {
  const ctx = useContext(ChannelContext);
  if (!ctx) throw new Error('useChannel must be used inside ChannelProvider');
  return ctx;
}
