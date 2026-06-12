import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import { App } from './App';
import { I18nProvider, t } from './i18n';
import { toast } from 'sonner';

const UPDATE_CHECK_BACKSTOP = 30 * 60 * 1000; // 30-min periodic fallback

const updateSW = registerSW({
  immediate: true,
  onRegisteredSW(_swScriptUrl, registration) {
    // The `prompt` flow only surfaces an update when the browser re-fetches
    // sw.js. For a tab left open for hours (a streamer's queue) that otherwise
    // only happens on a full reload — SPA navigation never triggers it — so the
    // toast never appears on its own. Re-check on the moments that matter:
    // returning to the tab and regaining network, plus a periodic backstop.
    if (!registration) return;
    const check = () => { if (navigator.onLine) registration.update(); };
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') check();
    });
    window.addEventListener('online', check);
    setInterval(check, UPDATE_CHECK_BACKSTOP);
  },
  onNeedRefresh() {
    // Don't activate the new SW eagerly — calling updateSW(true) here races
    // with the reload it triggers, so the waiting SW often doesn't actually
    // take control, and the next page load sees it still waiting → this
    // callback fires again, and the toast pops on every reload. Defer
    // activation to the user's click: skipWaiting + reload happens in one
    // controlled step, and the new page load has no waiting SW.
    toast(t('toast.newVersionAvailable'), {
      id: 'new-version',
      duration: Infinity,
      action: { label: t('toast.updateAction'), onClick: () => updateSW(true) },
    });
  }
});

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(<I18nProvider><App /></I18nProvider>);
}
