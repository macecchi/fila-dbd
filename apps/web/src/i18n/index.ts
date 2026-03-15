import { createContext, useContext, useState, useEffect, useCallback, createElement, type ReactNode } from 'react';
import ptBR, { type TranslationKeys } from './locales/pt-BR';
import en from './locales/en';

export type Locale = 'pt-BR' | 'en';

const STORAGE_KEY = 'dbd-locale';

const translations: Record<Locale, TranslationKeys> = { 'pt-BR': ptBR, en };

// --- Locale detection ---

export function detectLocale(): Locale {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'pt-BR' || saved === 'en') return saved;
  } catch { /* ignore */ }
  const lang = navigator.language || (navigator as any).userLanguage || '';
  return lang.startsWith('pt') ? 'pt-BR' : 'en';
}

// --- Module-level state (for standalone t() outside React) ---

let currentLocale: Locale = detectLocale();
let currentTranslations: TranslationKeys = translations[currentLocale];

export function getLocale(): Locale {
  return currentLocale;
}

function setModuleLocale(locale: Locale) {
  currentLocale = locale;
  currentTranslations = translations[locale];
}

// --- Standalone t() ---

type TranslationKey = keyof TranslationKeys;

export function t(key: TranslationKey, params?: Record<string, string | number>): string {
  let str: string = currentTranslations[key] ?? ptBR[key] ?? key;

  // Pluralization: if count param provided and !== 1, try _plural key
  if (params?.count !== undefined && params.count !== 1) {
    const pluralKey = (key + '_plural') as TranslationKey;
    const plural = currentTranslations[pluralKey] ?? ptBR[pluralKey];
    if (plural) str = plural;
  }

  // Interpolation
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      str = str.replaceAll(`{${k}}`, String(v));
    }
  }

  return str;
}

// --- React context ---

interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
}

const I18nContext = createContext<I18nContextValue>({
  locale: currentLocale,
  setLocale: () => {},
});

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(currentLocale);

  const setLocale = useCallback((newLocale: Locale) => {
    setLocaleState(newLocale);
    setModuleLocale(newLocale);
    try { localStorage.setItem(STORAGE_KEY, newLocale); } catch { /* ignore */ }
  }, []);

  // Sync module-level state on mount
  useEffect(() => {
    setModuleLocale(locale);
  }, [locale]);

  return createElement(I18nContext.Provider, { value: { locale, setLocale } }, children);
}

export function useTranslation() {
  const { locale, setLocale } = useContext(I18nContext);
  return { t, locale, setLocale };
}
