<script setup>
import { useI18n } from 'vue-i18n';
import { SUPPORTED_LOCALES, setLocale } from '../i18n/index.js';

const { locale, t } = useI18n();

function onChange(e) {
  setLocale(e.target.value);
}
</script>

<template>
  <label class="lang-switch">
    <span class="sr-only">{{ t('language.label') }}</span>
    <select :value="locale" :aria-label="t('language.label')" @change="onChange">
      <option v-for="code in SUPPORTED_LOCALES" :key="code" :value="code">
        {{ t(`language.${code}`) }}
      </option>
    </select>
  </label>
</template>

<style scoped>
.lang-switch select {
  width: auto;
  padding: 0.3rem 0.5rem;
  font-size: 0.85rem;
  border: 1px solid var(--rule-strong, #d2cec3);
  border-radius: 6px;
  background: transparent;
  color: var(--ink-soft, #4a4844);
  cursor: pointer;
}
.lang-switch select:hover {
  border-color: var(--ink-faint, #807d76);
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
</style>
