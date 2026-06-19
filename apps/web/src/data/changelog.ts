import type { TranslationKeys } from '../i18n/locales/pt-BR';

export interface ChangelogEntry {
  id: string;
  titleKey: keyof TranslationKeys;
  descriptionKey: keyof TranslationKeys;
}

/**
 * Hardcoded changelog entries shown as persistent toasts to channel owners.
 * Each entry is shown once and dismissed forever when closed.
 *
 * To add a new entry:
 * 1. Add a new object here with a unique `id`
 * 2. Add matching i18n keys in both pt-BR.ts and en.ts
 */
export const changelog: ChangelogEntry[] = [
  {
    id: 'whats-new-lang-toggle',
    titleKey: 'whatsNew.langToggleTitle',
    descriptionKey: 'whatsNew.langToggle',
  },
  {
    id: 'whats-new-multi-donate-bots',
    titleKey: 'whatsNew.multiDonateBotsTitle',
    descriptionKey: 'whatsNew.multiDonateBots',
  },
  {
    id: 'whats-new-chat-confirmations',
    titleKey: 'whatsNew.chatConfirmationsTitle',
    descriptionKey: 'whatsNew.chatConfirmations',
  },
  {
    id: 'whats-new-multi-request-donations',
    titleKey: 'whatsNew.multiRequestDonationsTitle',
    descriptionKey: 'whatsNew.multiRequestDonations',
  },
  {
    id: 'whats-new-build-requests',
    titleKey: 'whatsNew.buildRequestsTitle',
    descriptionKey: 'whatsNew.buildRequests',
  },
  {
    id: 'whats-new-source-ordering',
    titleKey: 'whatsNew.sourceOrderingTitle',
    descriptionKey: 'whatsNew.sourceOrdering',
  },
];
