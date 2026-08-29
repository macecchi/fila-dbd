// Web Push subscription for "your channel is live" notifications. Runs only on
// the streamer's own channel, only once notification permission is granted, and
// degrades to a no-op when the deployment has no VAPID keys or the browser has
// no Push API. Failures are logged, never surfaced — the local Notification
// path in ChannelContext keeps working regardless.
import { useAuth } from '../store/auth';
import { getLocale } from '../i18n';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8787';

// Per-browser opt-out (Settings → Behavior → Live notifications). When set,
// syncPushSubscription never (re-)subscribes — mirroring how notification
// permission itself is a per-browser choice. Absent = enabled.
const LIVE_NOTIF_DISABLED_KEY = 'fila-dbd-live-notif-disabled-v1';

export function isLivePushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

// The browser permission overrides the local preference: with notifications
// blocked no push can ever be delivered, so the UI must show the feature off
// (and say why) rather than claiming it is on.
export function isLivePushBlocked(): boolean {
  if (!isLivePushSupported()) return false;
  return Notification.permission === 'denied';
}

export function isLivePushDisabled(): boolean {
  try {
    return localStorage.getItem(LIVE_NOTIF_DISABLED_KEY) === '1';
  } catch {
    return false;
  }
}

function setLivePushDisabledFlag(disabled: boolean) {
  try {
    if (disabled) localStorage.setItem(LIVE_NOTIF_DISABLED_KEY, '1');
    else localStorage.removeItem(LIVE_NOTIF_DISABLED_KEY);
  } catch {
    // ignore (private mode / storage full)
  }
}

// Toggle handler for the settings panel. The preference itself is written
// synchronously so the UI can flip instantly; the subscription work — which
// waits on the service worker and the network — is serialized behind this
// promise so rapid toggling can't apply out of order.
let pushWork: Promise<void> = Promise.resolve();

export function setLivePushEnabled(enabled: boolean): Promise<void> {
  setLivePushDisabledFlag(!enabled);
  if (!isLivePushSupported()) return Promise.resolve();
  pushWork = pushWork.then(() => applyLivePushEnabled(enabled)).catch(() => {});
  return pushWork;
}

// Disabling drops this browser's push subscription locally and server-side;
// enabling (re-)requests permission if needed and re-subscribes.
async function applyLivePushEnabled(enabled: boolean): Promise<void> {
  if (enabled) {
    if (Notification.permission === 'default') {
      await Notification.requestPermission().catch(() => 'denied');
    }
    await syncPushSubscription();
    return;
  }

  try {
    const registration = await swRegistration();
    const subscription = await registration?.pushManager.getSubscription();
    if (!subscription) return;

    const { endpoint } = subscription;
    await subscription.unsubscribe();

    const token = await useAuth.getState().getAccessToken();
    if (!token) return;
    await fetch(`${API_URL}/api/push/unsubscribe`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ endpoint }),
    });
  } catch (e) {
    console.warn('[push] unsubscribe failed:', e);
  }
}

// `navigator.serviceWorker.ready` never settles when no worker is registered —
// the dev server registers none — so every await of it needs an escape hatch.
const SW_READY_TIMEOUT_MS = 5000;

async function swRegistration(): Promise<ServiceWorkerRegistration | null> {
  try {
    return await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), SW_READY_TIMEOUT_MS)),
    ]);
  } catch {
    return null;
  }
}

function urlBase64ToUint8Array(base64url: string): Uint8Array {
  const padding = '='.repeat((4 - (base64url.length % 4)) % 4);
  const base64 = (base64url + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

let syncing = false;

// Idempotent: reuses the browser's existing subscription when there is one and
// (re-)registers it with the server, which upserts by (streamer, endpoint).
export async function syncPushSubscription(): Promise<void> {
  if (syncing) return;
  if (!isLivePushSupported() || isLivePushDisabled()) return;
  if (Notification.permission !== 'granted') return;

  syncing = true;
  try {
    const token = await useAuth.getState().getAccessToken();
    if (!token) return;

    const registration = await swRegistration();
    if (!registration) return;
    let subscription = await registration.pushManager.getSubscription();

    if (!subscription) {
      const res = await fetch(`${API_URL}/push/vapid-public-key`);
      if (!res.ok) return;
      const { key } = await res.json() as { key: string };
      if (!key) return; // deployment has push disabled

      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key) as BufferSource,
      });
    }

    const subscribeRes = await fetch(`${API_URL}/api/push/subscribe`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      // The service worker can't read the language toggle, so the language is
      // stored with the subscription and comes back with the push.
      body: JSON.stringify({ ...subscription.toJSON(), locale: getLocale() }),
    });
    if (!subscribeRes.ok) {
      console.warn(`[push] subscribe registration failed: ${subscribeRes.status}`);
    }
  } catch (e) {
    console.warn('[push] subscription sync failed:', e);
  } finally {
    syncing = false;
  }
}
