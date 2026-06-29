<script setup>
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { SUPPORTED_LOCALES, setLocale } from '../i18n/index.js';

const { locale, t } = useI18n();

// Two-locale toggle: the button shows the language it will switch TO, and
// clicking it cycles to the next supported locale.
const nextLocale = computed(() => {
  const i = SUPPORTED_LOCALES.indexOf(locale.value);
  return SUPPORTED_LOCALES[(i + 1) % SUPPORTED_LOCALES.length];
});

function toggle() {
  setLocale(nextLocale.value);
}
</script>

<template>
  <button
    type="button"
    class="ghost lang-toggle"
    :title="t('language.label')"
    :aria-label="t('language.label')"
    @click="toggle"
  >
    {{ t(`language.${nextLocale}`) }}
  </button>
</template>

<style scoped>
.lang-toggle {
  white-space: nowrap;
}
</style>
