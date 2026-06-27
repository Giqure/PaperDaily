<script setup>
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { auth } from '../store.js';

const router = useRouter();
const loggingOut = ref(false);

async function logout() {
  loggingOut.value = true;
  try {
    await auth.logout();
    router.replace('/');
  } finally {
    loggingOut.value = false;
  }
}
</script>

<template>
  <div class="home">
    <h1>Dashboard</h1>
    <p class="sub">Your daily digest of research papers.</p>

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
