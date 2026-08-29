/// <reference lib="webworker" />
// Custom service worker (vite-plugin-pwa injectManifest). Replaces the
// previously generated SW, so it must keep its behavior: precache all assets,
// serve index.html for navigations, and activate on the SKIP_WAITING message
// posted by window.__triggerSWUpdate (see main.tsx / UpdateToast). On top of
// that it handles Web Push — the "your channel is live" notification.
import { precacheAndRoute, createHandlerBoundToURL, cleanupOutdatedCaches } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { pushCopy, normalizePushLocale } from './i18n/pushCopy';

declare let self: ServiceWorkerGlobalScope;

cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);
registerRoute(new NavigationRoute(createHandlerBoundToURL('index.html')));

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

// The strings live in i18n/pushCopy.ts; the language comes with the payload,
// since this worker can't read the app's language toggle (localStorage is off
// limits here) and the browser language can contradict the UI.
interface LivePushPayload {
  type?: string;
  channel?: string;
  locale?: string;
  pending?: number;
}

self.addEventListener('push', (event) => {
  let payload: LivePushPayload = {};
  try {
    payload = event.data?.json() ?? {};
  } catch {
    // Not JSON (or empty) — nothing we can render.
  }

  if (payload.type !== 'stream-online' || !payload.channel) return;

  const copy = pushCopy[normalizePushLocale(payload.locale)];

  event.waitUntil(
    self.registration.showNotification(copy.title(payload.pending ?? 0), {
      body: copy.body,
      tag: 'dbd-stream-online',
      icon: '/images/Dead-by-Daylight-Emblem.webp',
      badge: '/images/Dead-by-Daylight-Emblem.webp',
      data: { channel: payload.channel },
    })
  );
});

// Clicking the notification is the streamer saying "yes, open it" — so the tab
// is focused *and* the queue is started. An already-open tab is told over
// postMessage; a tab we have to open or navigate carries the intent in the URL,
// since there is no client to message until it has loaded. Both are handled in
// store/ChannelContext.tsx.
const OPEN_QUEUE_PARAM = 'open-queue';

// Paths are compared with a trailing slash on both sides: the app is served at
// /channel/ but the notification only knows the channel name, and treating
// those as different tabs used to reload whatever tab was focused instead of
// landing on the channel.
function samePath(a: string, b: string): boolean {
  const trim = (p: string) => (p.endsWith('/') ? p.slice(0, -1) : p).toLowerCase();
  return trim(a) === trim(b);
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const channel: string | undefined = event.notification.data?.channel;
  if (!channel) return;

  const path = `/${channel}/`;
  const url = `${path}?${OPEN_QUEUE_PARAM}=1`;

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });

      const onChannel = windows.find((w) => samePath(new URL(w.url).pathname, path));
      if (onChannel) {
        await onChannel.focus();
        onChannel.postMessage({ type: 'open-queue', channel });
        return;
      }

      // Another page of the app: focus it and send it to the channel (an SPA
      // navigation would lose the query string, so navigate() carries it).
      const anyTab = windows[0];
      if (anyTab) {
        await anyTab.focus();
        await anyTab.navigate(url).catch(() => {});
        return;
      }

      await self.clients.openWindow(url);
    })()
  );
});
