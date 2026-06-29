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
    <!-- All labels share one grid cell so the button sizes to the widest one
         and never reflows when the active label swaps. Only the next locale's
         label is visible; the others reserve space but stay hidden. -->
    <span class="lang-stack" aria-hidden="true">
      <span
        v-for="code in SUPPORTED_LOCALES"
        :key="code"
        class="lang-label"
        :class="{ shown: code === nextLocale }"
      >
        {{ t(`language.${code}`) }}
      </span>
    </span>
  </button>
</template>

<style scoped>
.lang-toggle {
  white-space: nowrap;
}
/* Stack every possible label in a single grid cell: the button's intrinsic
   width becomes the widest label's width, so toggling never changes its size. */
.lang-stack {
  display: inline-grid;
}
.lang-label {
  grid-area: 1 / 1;
  visibility: hidden;
}
.lang-label.shown {
  visibility: visible;
}
</style>
