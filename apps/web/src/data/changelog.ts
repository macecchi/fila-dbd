import type { TranslationKeys } from '../i18n/locales/pt-BR';

export interface ChangelogEntry {
  id: string;
  /** Day it shipped, `YYYY-MM-DD` — shown so the streamer can tell how new it is. */
  date: string;
  /** One line each; the release's user-facing changes. */
  items: (keyof TranslationKeys)[];
}

/**
 * Release notes shown to channel owners in the "What's new" toast. An entry is shown
 * until the streamer closes the toast, then never again on that browser.
 *
 * To add a release:
 * 1. Add an object at the top with a unique `id` and the day it ships
 * 2. Add its item keys to both pt-BR.ts and en.ts
 * Delete entries once they're old news — anyone who hasn't seen them yet would get
 * them all at once.
 */
export const changelog: ChangelogEntry[] = [
  {
    id: 'release-2026-09-28',
    date: '2026-09-28',
    items: ['whatsNew.queueSaveFix', 'whatsNew.performance'],
  },
];
