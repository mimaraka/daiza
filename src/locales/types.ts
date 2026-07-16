export type Locale = 'en' | 'th' | 'ja';

export const AVAILABLE_LOCALES: readonly Locale[] = ['en', 'th', 'ja'];

export const DEFAULT_FALLBACK_LOCALE: Locale = 'en';

export const LOCALE_STORAGE_KEY = 'daiza-locale';
