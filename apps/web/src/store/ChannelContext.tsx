// apps/web/src/store/ChannelContext.tsx
import { createContext, useContext, useMemo, useEffect, useRef, useCallback } from 'react';
import { createRoomStores, type ChannelStores } from './channel';
import { setActiveStores, connect as connectIrc, disconnect as disconnectIrc } from '../services/twitch';
import { connectParty, disconnectParty, broadcastIrcStatus, claimOwnership, releaseOwnership } from '../services/party';
import { useAuth } from './auth';
import { toast } from 'sonner';
import { MAX_PENDING_REQUESTS } from '@filadbd/shared';
import { t } from '../i18n';
import { showNewVersionToast } from '../components/UpdateToast';
import { syncPushSubscription } from '../services/push';

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
  canEditQueue: boolean;
  /** Start taking requests here, taking the lock from another window if it has it. */
  openQueue: () => void;
  /** Stop taking requests, wherever the session driving the channel happens to be. */
  closeQueue: () => void;
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
  const partySynced = stores.useChannelInfo((s) => s.partySynced);
  const closedByOwner = stores.useChannelInfo((s) => s.closedByOwner);
  // Another window of ours is driving the channel, so this one must not also join IRC.
  const someoneElseIsOwner = isOwnChannel && !hasLock && owner !== null;

  // Last broadcast sources signature — used to skip the "queue settings updated"
  // toast when an update-sources message carries no meaningful change (e.g. the user
  // blurs an EditableField without editing, which still re-dispatches the value).
  const lastSourcesSignature = useRef<string | null>(null);

  // What the streamer last asked for in this window. Without it a deliberate close would
  // be undone: the claim below would take the freed room back, and the IRC effect would
  // reopen the queue on the new lock.
  const queueIntent = useRef<'open' | 'closed'>('open');

  // Take the room back whenever it's free and ours: first sync, after a reconnect (the
  // server drops ownership when our socket closes, which used to leave the tab demoted
  // until reload), or when another session goes away. Gated on partySynced so `owner` is
  // the server's current answer, and re-armed only when ownership changes hands, so a
  // refusal can't spin.
  const hasTriedAutoClaim = useRef(false);
  const prevOwnerLogin = useRef<string | null>(null);
  useEffect(() => {
    const ownerLogin = owner?.login ?? null;
    if (ownerLogin !== prevOwnerLogin.current) {
      prevOwnerLogin.current = ownerLogin;
      if (ownerLogin === null) hasTriedAutoClaim.current = false;
    }
    if (!partySynced) {
      hasTriedAutoClaim.current = false;
      return;
    }
    if (!isOwnChannel || hasLock || owner || hasTriedAutoClaim.current) return;
    // A queue the streamer closed stays closed: only openQueue() reopens it.
    if (closedByOwner || queueIntent.current === 'closed') return;
    hasTriedAutoClaim.current = true;
    claimOwnership();
  }, [isOwnChannel, partySynced, owner, hasLock, closedByOwner]);

  // Auto-connect to IRC once when ownership is first granted — unless the lock was taken
  // for the express purpose of closing the queue in whichever window still drives it.
  const hasAutoConnectedIrc = useRef(false);
  useEffect(() => {
    if (hasLock && queueIntent.current === 'closed') {
      disconnectIrc();
      releaseOwnership();
      return;
    }
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
        // Register this browser for server-sent pushes too ("your channel is
        // live" when the stream starts with the site closed). Fire-and-forget.
        void syncPushSubscription();
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

  // Both sockets recover on their own within a second or two, so warning on the drop
  // itself turns every blip into warn-then-success churn. Say nothing until an outage
  // outlives the grace window, and only confirm a recovery we warned about.
  const RECONNECT_GRACE = 5_000;
  const ircWarnTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const partyWarnTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ircWarned = useRef(false);
  const partyWarned = useRef(false);

  const clearTimer = (ref: React.MutableRefObject<ReturnType<typeof setTimeout> | null>) => {
    if (ref.current) {
      clearTimeout(ref.current);
      ref.current = null;
    }
  };

  useEffect(() => {
    if (!isOwnChannel) {
      prevIrcState.current = localIrcState;
      prevPartyState.current = partyConnected;
      return;
    }

    const wasIrcConnected = prevIrcState.current === 'connected';

    // IRC: connected → connecting (auto-reconnecting)
    if (wasIrcConnected && localIrcState === 'connecting' && !ircWarnTimer.current) {
      ircWarnTimer.current = setTimeout(() => {
        ircWarnTimer.current = null;
        ircWarned.current = true;
        toast.warning(t('toast.twitchIrc'), { id: 'irc-status', description: t('toast.ircReconnecting') });
      }, RECONNECT_GRACE);
    }

    // IRC: connected/connecting → error (retries exhausted). Terminal, so no grace window.
    if (wasIrcConnected && localIrcState === 'error') {
      clearTimer(ircWarnTimer);
      ircWarned.current = true;
      toast.error(t('toast.twitchIrc'), { id: 'irc-status', description: t('toast.ircLost'), duration: Infinity });
      sendPushNotification(
        t('push.connectionLost'),
        t('push.ircLost'),
      );
    }

    // IRC: reconnected successfully (not initial connect)
    if (prevIrcState.current === 'connecting' && localIrcState === 'connected' && ircEverConnected.current) {
      clearTimer(ircWarnTimer);
      if (ircWarned.current) {
        toast.success(t('toast.twitchIrc'), { id: 'irc-status', description: t('toast.ircReconnected') });
        ircWarned.current = false;
      }
    }
    if (localIrcState === 'connected') ircEverConnected.current = true;

    // PartyKit: disconnected — toast after the grace window, push after the longer delay
    if (prevPartyState.current && !partyConnected) {
      if (!partyWarnTimer.current) {
        partyWarnTimer.current = setTimeout(() => {
          partyWarnTimer.current = null;
          partyWarned.current = true;
          toast.warning(t('toast.server'), { id: 'party-status', description: t('toast.serverReconnecting') });
        }, RECONNECT_GRACE);
      }
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

    // PartyKit: reconnected — cancel the pending warning and push
    if (!prevPartyState.current && partyConnected) {
      clearTimer(partyPushTimer);
      clearTimer(partyWarnTimer);
      if (partyEverConnected.current && partyWarned.current) {
        toast.success(t('toast.server'), { id: 'party-status', description: t('toast.serverReconnected') });
      }
      partyWarned.current = false;
    }
    if (partyConnected) partyEverConnected.current = true;

    prevIrcState.current = localIrcState;
    prevPartyState.current = partyConnected;
  }, [localIrcState, partyConnected, isOwnChannel]);

  // Cleanup connection timers on unmount
  useEffect(() => {
    return () => {
      clearTimer(partyPushTimer);
      clearTimer(partyWarnTimer);
      clearTimer(ircWarnTimer);
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
              showNewVersionToast({ description: t('toast.newVersionUpdate'), warning: true });
              sendPushNotification(t('push.newVersionTitle'), t('push.newVersion'));
              return;
            }
            // Authority rejections mean another session holds the lock, or ours went
            // stale across a reconnect — not something to alarm the streamer with. The
            // claim effect takes the room back once it's free; just nudge it.
            if (msg.code === 'not_room_owner' || msg.code === 'not_lock_holder') {
              if (isOwnChannel && !stores.useChannelInfo.getState().owner) {
                claimOwnership();
              }
              return;
            }
            if (msg.code === 'pending_cap') {
              // The store already rolled the optimistic add back; this is the race where
              // two sessions filled the last slot at once.
              toast.warning(t('toast.queueFull', { max: String(MAX_PENDING_REQUESTS) }), {
                id: 'queue-full',
                description: t('toast.queueFullDesc'),
                duration: 10000,
              });
              return;
            }
            if (msg.code === 'chat_send_not_mod') {
              toast.warning(t('toast.chatBot'), { id: 'chat-bot', description: msg.message, duration: 10000 });
              return;
            }
            // Real failures (DO/D1 persistence) stay up, under their own id so they
            // don't stomp the connection toasts.
            toast.error(t('toast.serverError'), {
              id: 'server-error',
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

  // Every session of the streamer manages the queue: the server authorizes mutations per
  // room owner, not per lock holder, so no window needs a read-only mode.
  const canEditQueue = isOwnChannel;

  // Opening and closing are channel-level, so they work from any window. Without the lock
  // we claim first — the server hands it over — and the effect above then connects IRC, or
  // shuts the channel down when we're closing.
  const openQueue = useCallback(() => {
    queueIntent.current = 'open';
    hasAutoConnectedIrc.current = false;
    if (hasLock) {
      if (localIrcState !== 'connected') connectIrc(channel);
    } else {
      claimOwnership();
    }
  }, [hasLock, localIrcState, channel]);

  const closeQueue = useCallback(() => {
    queueIntent.current = 'closed';
    if (hasLock) {
      disconnectIrc();
      releaseOwnership();
    } else {
      claimOwnership();
    }
  }, [hasLock]);

  const value = useMemo(
    () => ({ channel, isOwnChannel, canEditQueue, openQueue, closeQueue, ...stores }),
    [channel, isOwnChannel, canEditQueue, openQueue, closeQueue, stores]
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
