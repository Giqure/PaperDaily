<script setup>
import { ref, computed, onMounted } from 'vue';
import { auth } from '../store.js';

const title = ref('PaperDaily');
const message = ref('Your daily digest of research papers.');

// The single entry point adapts to auth state: a signed-in visitor goes
// straight to their dashboard; a guest is sent to log in.
const loggedIn = computed(() => !!auth.state.user);
const entry = computed(() =>
  loggedIn.value
    ? { to: '/dashboard', label: 'Go to dashboard' }
    : { to: '/login', label: 'Log in' }
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
        Signed in as
        <strong>{{ auth.state.user.name || auth.state.user.email }}</strong>
      </p>
    </div>
  </div>
</template>
