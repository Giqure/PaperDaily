import { createI18n } from 'vue-i18n';
import en from '../locales/en.js';
import zhCN from '../locales/zh-CN.js';

export const SUPPORTED_LOCALES = ['en', 'zh-CN'];
export const DEFAULT_LOCALE = 'en';
const STORAGE_KEY = 'paperdaily.locale';

// Resolve the startup locale: an explicit saved choice wins, otherwise fall back
// to the browser's preferred language, otherwise the default. Anything we don't
// support collapses to the default so createI18n never starts on an empty bundle.
function resolveLocale() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved && SUPPORTED_LOCALES.includes(saved)) return saved;

  const nav = (navigator.languages && navigator.languages[0]) || navigator.language || '';
  if (/^zh\b/i.test(nav)) return 'zh-CN';
  if (SUPPORTED_LOCALES.includes(nav)) return nav;

  return DEFAULT_LOCALE;
}

export const i18n = createI18n({
  legacy: false, // Composition API ($t in templates, useI18n() in setup)
  locale: resolveLocale(),
  fallbackLocale: DEFAULT_LOCALE,
  messages: { en, 'zh-CN': zhCN },
});

// Switch the active locale and remember it. Also reflects it on <html lang> so
// the document language stays accurate for accessibility tools.
export function setLocale(locale) {
  if (!SUPPORTED_LOCALES.includes(locale)) return;
  i18n.global.locale.value = locale;
  localStorage.setItem(STORAGE_KEY, locale);
  document.documentElement.setAttribute('lang', locale);
}

// Keep <html lang> in sync with the resolved startup locale.
document.documentElement.setAttribute('lang', i18n.global.locale.value);
