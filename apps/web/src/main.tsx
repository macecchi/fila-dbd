import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import { App } from './App';
import { I18nProvider } from './i18n';
import { showNewVersionToast } from './components/UpdateToast';
import { initAnalytics, identify, resetIdentity } from './services/analytics';
import { useAuth } from './store/auth';

const UPDATE_CHECK_BACKSTOP = 30 * 60 * 1000; // 30-min periodic fallback
const UPDATE_RETRY_DELAY = 15 * 1000;

// Single reload point for SW updates — everything else just posts SKIP_WAITING
// and waits for this event. The `refreshing` flag dedupes across tabs.
if ('serviceWorker' in navigator) {
  let refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing) return;
    refreshing = true;
    window.location.reload();
  });
}

registerSW({
  immediate: true,
  onRegisteredSW(swScriptUrl, initialRegistration) {
    // SPA navigation never re-fetches sw.js, so a tab left open for hours
    // won't discover updates on its own. Re-check on tab focus, reconnect,
    // and a periodic backstop.
    if (!initialRegistration) return;
    let registration = initialRegistration;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      if (!navigator.onLine) return;
      clearTimeout(retry);
      // The browser can drop the registration under an open tab (Safari evicting
      // site data, the user clearing it, an unregister from another tab). The
      // object we hold then has no worker left, and update() rejects with
      // InvalidStateError ("newestWorker is null") on every check, forever.
      // Register again instead: sw.ts never calls clients.claim(), so the fresh
      // worker only takes over on the next load and this tab isn't reloaded.
      if (!registration.installing && !registration.waiting && !registration.active) {
        navigator.serviceWorker.register(swScriptUrl, { scope: registration.scope })
          .then((fresh) => { registration = fresh; });
        return;
      }
      registration.update().catch(() => {
        // Only a second failure in a row is reported (unhandled → PostHog); a blip on wake just retries.
        retry = setTimeout(() => { if (navigator.onLine) registration.update(); }, UPDATE_RETRY_DELAY);
      });
    };
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') check();
    });
    window.addEventListener('online', check);
    setInterval(check, UPDATE_CHECK_BACKSTOP);
  },
  onNeedRefresh() {
    // Don't use updateSW(true) — its reload() races with skipWaiting and
    // often serves stale assets. We post SKIP_WAITING directly and let
    // the controllerchange listener reload after the new SW takes control.
    // The toast auto-updates after sustained user inactivity (see UpdateToast).
    showNewVersionToast();
  }
});

// Used by both the onNeedRefresh toast and ChannelContext's version_mismatch handler.
window.__triggerSWUpdate = async () => {
  if ('serviceWorker' in navigator) {
    const registration = await navigator.serviceWorker.getRegistration();
    if (registration?.waiting) {
      registration.waiting.postMessage({ type: 'SKIP_WAITING' });
      return;
    }
  }
  // No waiting SW (already activated via another tab, or absent) — plain reload.
  window.location.reload();
};

// PostHog loads after first paint, when idle (services/analytics.ts). Streamers are
// identified by their Twitch login while signed in; viewers stay anonymous.
initAnalytics();
const syncIdentity = (login: string | undefined) => (login ? identify(login) : resetIdentity());
syncIdentity(useAuth.getState().user?.login);
useAuth.subscribe((s) => syncIdentity(s.user?.login));

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(<I18nProvider><App /></I18nProvider>);
}
