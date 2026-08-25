/// <reference lib="webworker" />
// Custom service worker (vite-plugin-pwa injectManifest). Replaces the
// previously generated SW, so it must keep its behavior: precache all assets,
// serve index.html for navigations, and activate on the SKIP_WAITING message
// posted by window.__triggerSWUpdate (see main.tsx / UpdateToast). On top of
// that it handles Web Push — the "your channel is live" notification.
import { precacheAndRoute, createHandlerBoundToURL, cleanupOutdatedCaches } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';

declare let self: ServiceWorkerGlobalScope;

cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);
registerRoute(new NavigationRoute(createHandlerBoundToURL('index.html')));

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

// The app's language toggle lives in localStorage, which a SW can't read — the
// browser language is the best signal available here.
function isPortuguese(): boolean {
  return (self.navigator.language || '').toLowerCase().startsWith('pt');
}

interface LivePushPayload {
  type?: string;
  channel?: string;
  channelDisplayName?: string;
}

self.addEventListener('push', (event) => {
  let payload: LivePushPayload = {};
  try {
    payload = event.data?.json() ?? {};
  } catch {
    // Not JSON (or empty) — fall through to the generic notification.
  }

  if (payload.type !== 'stream-online' || !payload.channel) return;

  const name = payload.channelDisplayName || payload.channel;
  const title = isPortuguese() ? `🔴 ${name} está ao vivo!` : `🔴 ${name} is live!`;
  const body = isPortuguese()
    ? 'Abra sua fila no Fila DBD para começar a receber pedidos.'
    : 'Open your queue on Fila DBD to start taking requests.';

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag: 'dbd-stream-online',
      icon: '/images/Dead-by-Daylight-Emblem.webp',
      badge: '/images/Dead-by-Daylight-Emblem.webp',
      data: { url: `/${payload.channel}` },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url: string = event.notification.data?.url ?? '/';

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      // Prefer a tab already on the channel page, then any app tab (SPA
      // navigation happens when the streamer clicks through), else a new one.
      const existing =
        windows.find((w) => new URL(w.url).pathname === url) ?? windows[0];
      if (existing) {
        await existing.focus();
        if (new URL(existing.url).pathname !== url) await existing.navigate(url).catch(() => {});
        return;
      }
      await self.clients.openWindow(url);
    })()
  );
});
