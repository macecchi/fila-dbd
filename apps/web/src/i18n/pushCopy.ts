// Copy for the "you're live" Web Push. Kept out of locales/{en,pt-BR}.ts
// because the service worker imports it: those are ~200-key object literals
// that don't tree-shake, and sw.js is re-fetched on every deploy.
//
// The worker can't read the language toggle (`dbd-locale` is in localStorage,
// off limits there) and the browser language can contradict the UI — so the
// locale travels with the push: stored per subscription when the browser
// registers, sent back in the payload (apps/api/src/index.ts).
export type PushLocale = 'pt-BR' | 'en';

export const pushCopy: Record<PushLocale, { title: (pending: number) => string; body: string }> = {
  en: {
    title: (pending) =>
      pending > 0
        ? `${pending} request${pending === 1 ? '' : 's'} on Fila DBD`
        : "Fila DBD is waiting",
    body: 'Open your queue to receive requests. You can turn this notification off in the settings.',
  },
  'pt-BR': {
    title: (pending) =>
      pending > 0
        ? `${pending} pedido${pending === 1 ? '' : 's'} no Fila DBD`
        : 'Fila DBD está esperando',
    body: 'Abra sua fila para receber pedidos. Você pode desativar este aviso nas configurações.',
  },
};

// Anything Portuguese maps to pt-BR; everything else falls back to English.
export function normalizePushLocale(locale: string | null | undefined): PushLocale {
  return locale?.toLowerCase().startsWith('pt') ? 'pt-BR' : 'en';
}
