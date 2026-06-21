import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import { App } from './App';
import { I18nProvider, t } from './i18n';
import { toast } from 'sonner';

const UPDATE_CHECK_BACKSTOP = 30 * 60 * 1000; // 30-min periodic fallback

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
  onRegisteredSW(_swScriptUrl, registration) {
    // SPA navigation never re-fetches sw.js, so a tab left open for hours
    // won't discover updates on its own. Re-check on tab focus, reconnect,
    // and a periodic backstop.
    if (!registration) return;
    const check = () => { if (navigator.onLine) registration.update(); };
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
    toast(t('toast.newVersionAvailable'), {
      id: 'new-version',
      duration: Infinity,
      action: { label: t('toast.updateAction'), onClick: () => window.__triggerSWUpdate?.() },
    });
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

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(<I18nProvider><App /></I18nProvider>);
}
