import { createI18n } from 'vue-i18n';
import en from '../locales/en.js';
import zhCN from '../locales/zh-CN.js';

// Three language modes:
//   zh-CN  — Chinese UI, Chinese scope names
//   en     — English UI, Chinese scope names (the default)
//   en-all — English UI, English scope names ("all English")
// `en` and `en-all` share the English message bundle; they differ only in how
// scope names render (see scopeLabel.js). `en-all` is not a real BCP-47 tag, so
// anything handing the locale to Intl must map it back to `en` first.
//
// SUPPORTED_LOCALES are every mode the app can render; SWITCHABLE_LOCALES are the
// ones the language switcher offers. en-all is a planned Space-page feature with
// no UI entry yet — it stays renderable but isn't in the switcher cycle, so the
// public pages (where scope names don't appear) don't show a no-op third option.
export const SUPPORTED_LOCALES = ['zh-CN', 'en', 'en-all'];
export const SWITCHABLE_LOCALES = ['zh-CN', 'en'];
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
  // en-all reuses the English UI bundle — only scope names change.
  messages: { en, 'zh-CN': zhCN, 'en-all': en },
});

// Switch the active locale and remember it. Also reflects it on <html lang> so
// the document language stays accurate for accessibility tools.
export function setLocale(locale) {
  if (!SUPPORTED_LOCALES.includes(locale)) return;
  i18n.global.locale.value = locale;
  localStorage.setItem(STORAGE_KEY, locale);
  document.documentElement.setAttribute('lang', intlLocale(locale));
}

// Keep <html lang> in sync with the resolved startup locale.
document.documentElement.setAttribute('lang', intlLocale(i18n.global.locale.value));

// Map an app locale to a tag Intl accepts. `en-all` is not a valid BCP-47 tag
// (it would throw in Intl APIs), and it's just English for formatting purposes.
export function intlLocale(locale) {
  return String(locale) === 'en-all' ? 'en' : locale;
}
