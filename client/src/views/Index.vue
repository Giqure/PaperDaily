<script setup>
import { ref, computed, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { auth } from '../store.js';
import LanguageSwitcher from '../components/LanguageSwitcher.vue';

const { t } = useI18n();

// Defaults come from the active locale; the /api/welcome response (server-driven
// marketing copy) overrides them when available.
const title = ref(t('app.name'));
const message = ref(t('index.tagline'));

// The single entry point adapts to auth state: a signed-in visitor goes
// straight to their dashboard; a guest is sent to log in.
const loggedIn = computed(() => !!auth.state.user);
const entry = computed(() =>
  loggedIn.value
    ? { to: '/space', label: t('index.goToSpace') }
    : { to: '/login', label: t('index.login') }
);

onMounted(async () => {
  try {
    const res = await fetch('/api/welcome');
    if (res.ok) {
      const data = await res.json();
      title.value = data.title;
      message.value = data.message;
    }
  } catch {
    // API unavailable — keep defaults
  }
});
</script>

<template>
  <div class="home">
    <h1>{{ title }}</h1>
    <p class="sub">{{ message }}</p>

    <div class="account">
      <RouterLink class="entry" :to="entry.to">{{ entry.label }}</RouterLink>
      <p v-if="loggedIn" class="signed-in">
        {{ t('index.signedInAs') }}
        <strong>{{ auth.state.user.name || auth.state.user.email }}</strong>
      </p>
    </div>
    <LanguageSwitcher class="home-lang" />
  </div>
</template>

<style scoped>
.home-lang {
  margin-top: 2rem;
}
</style>
