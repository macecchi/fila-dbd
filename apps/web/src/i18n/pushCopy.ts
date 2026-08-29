export type PushLocale = 'pt-BR' | 'en';

export const pushCopy: Record<PushLocale, { title: (pending: number) => string; body: string }> = {
  en: {
    title: (pending) =>
      pending > 0
        ? `${pending} request${pending === 1 ? '' : 's'} on Fila DBD`
        : "Fila DBD is waiting",
    body: 'Click to open your queue. You can turn this notification off in the settings.',
  },
  'pt-BR': {
    title: (pending) =>
      pending > 0
        ? `${pending} pedido${pending === 1 ? '' : 's'} no Fila DBD`
        : 'Fila DBD está esperando',
    body: 'Clique para abrir sua fila. Você pode desativar este aviso nas configurações.',
  },
};

// Anything Portuguese maps to pt-BR; everything else falls back to English.
export function normalizePushLocale(locale: string | null | undefined): PushLocale {
  return locale?.toLowerCase().startsWith('pt') ? 'pt-BR' : 'en';
}
