// Web Push subscription for "your channel is live" notifications. Runs only on
// the streamer's own channel, only once notification permission is granted, and
// degrades to a no-op when the deployment has no VAPID keys or the browser has
// no Push API. Failures are logged, never surfaced — the local Notification
// path in ChannelContext keeps working regardless.
import { useAuth } from '../store/auth';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8787';

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
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return;
  if (Notification.permission !== 'granted') return;

  syncing = true;
  try {
    const token = await useAuth.getState().getAccessToken();
    if (!token) return;

    const registration = await navigator.serviceWorker.ready;
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
      body: JSON.stringify(subscription.toJSON()),
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
