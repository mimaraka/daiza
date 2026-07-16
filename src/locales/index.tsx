/* eslint-disable react-refresh/only-export-components */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { en } from './en';
import { ja } from './ja';
import { th } from './th';
import {
  AVAILABLE_LOCALES,
  DEFAULT_FALLBACK_LOCALE,
  LOCALE_STORAGE_KEY,
  type Locale,
} from './types';

export { AVAILABLE_LOCALES, DEFAULT_FALLBACK_LOCALE, LOCALE_STORAGE_KEY, type Locale };

export type TranslationKey = keyof typeof en;

const dictionaries: Record<Locale, Record<TranslationKey, string>> = {
  en,
  th,
  ja,
};

function getBrowserLocale(): Locale | null {
  if (typeof navigator === 'undefined') {
    return null;
  }
  const languages = navigator.languages ?? [navigator.language];
  for (const language of languages) {
    const code = language.split('-')[0];
    if (code && (AVAILABLE_LOCALES as readonly string[]).includes(code)) {
      return code as Locale;
    }
  }
  return null;
}

function getInitialLocale(): Locale {
  if (typeof window === 'undefined') {
    return DEFAULT_FALLBACK_LOCALE;
  }
  const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY);
  if (stored && (AVAILABLE_LOCALES as readonly string[]).includes(stored)) {
    return stored as Locale;
  }
  return getBrowserLocale() ?? DEFAULT_FALLBACK_LOCALE;
}

export interface LocaleContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}

export const LocaleContext = createContext<LocaleContextValue | null>(null);

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(getInitialLocale);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(LOCALE_STORAGE_KEY, next);
    }
  }, []);

  const t = useCallback(
    (key: TranslationKey, params?: Record<string, string | number>) => {
      const dictionary = dictionaries[locale];
      let text = dictionary[key] ?? en[key] ?? key;
      if (params) {
        text = text.replace(/\{\{(\w+)\}\}/g, (_, name: string) => {
          const value = params[name];
          return value !== undefined ? String(value) : `{{${name}}}`;
        });
      }
      return text;
    },
    [locale],
  );

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const value = useMemo(() => ({ locale, setLocale, t }), [locale, setLocale, t]);

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale(): LocaleContextValue {
  const context = useContext(LocaleContext);
  if (!context) {
    throw new Error('useLocale must be used within a LocaleProvider');
  }
  return context;
}

export function useTranslation(): { t: LocaleContextValue['t']; locale: Locale } {
  const { t, locale } = useLocale();
  return { t, locale };
}
