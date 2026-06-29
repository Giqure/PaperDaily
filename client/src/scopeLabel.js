// Resolve a scope's display label for the active locale. Scopes carry an
// optional English (nameEn) and Chinese (nameZh) label alongside the canonical
// `name` (the internal join/grouping key, which the UI never relies on for
// display).
//
// Three language modes (see i18n/index.js):
//   zh-CN  — Chinese scope names
//   en     — Chinese scope names (English UI, but scope names stay CN)
//   en-all — English scope names ("all English")
// Only en-all shows the English label; every other mode shows the Chinese one.
// Each falls back to the canonical name when its label is missing.
export function scopeLabel(scope, locale = 'en') {
  if (!scope) return '';
  if (String(locale) === 'en-all') return scope.nameEn || scope.name || '';
  return scope.nameZh || scope.name || '';
}
