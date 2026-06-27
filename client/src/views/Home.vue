<script setup>
import { ref, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { auth } from '../store.js';

const router = useRouter();

const title = ref('PaperDaily');
const message = ref('Your daily digest of research papers.');
const loggingOut = ref(false);

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

async function logout() {
  loggingOut.value = true;
  try {
    await auth.logout();
    router.replace('/login');
  } finally {
    loggingOut.value = false;
  }
}
</script>

<template>
  <div class="home">
    <h1>{{ title }}</h1>
    <p class="sub">{{ message }}</p>

    <div class="account">
      <p>
        Signed in as
        <strong>{{ auth.state.user.name || auth.state.user.email }}</strong>
      </p>
      <button class="ghost" :disabled="loggingOut" @click="logout">
        {{ loggingOut ? 'Logging out…' : 'Log out' }}
      </button>
    </div>
  </div>
</template>
