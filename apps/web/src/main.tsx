import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import { App } from './App';
import { I18nProvider, t } from './i18n';
import { useToasts } from './store/toasts';

// Set CSS custom properties for image paths that need base URL
const base = import.meta.env.BASE_URL;
document.documentElement.style.setProperty('--portrait-bg', `url('${base}images/CharPortrait_bg.webp')`);
document.documentElement.style.setProperty('--portrait-role-bg', `url('${base}images/CharPortrait_roleBG.webp')`);

const updateSW = registerSW({
  immediate: true,
  onNeedRefresh() {
    // Activate new SW so assets are cached, then prompt user to reload
    updateSW(true);
    useToasts.getState().add({
      message: t('toast.clickToUpdate'),
      title: t('toast.newVersionAvailable'),
      duration: 0,
      type: 'default',
      onClick: () => location.reload(),
    });
  }
});

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(<I18nProvider><App /></I18nProvider>);
}