<script setup>
import { ref } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { auth } from '../store.js';

const router = useRouter();
const route = useRoute();

const email = ref('');
const password = ref('');
const error = ref('');
const submitting = ref(false);

async function submit() {
  error.value = '';
  submitting.value = true;
  try {
    await auth.login(email.value.trim(), password.value);
    // Return to where the guard sent us from, else home.
    const dest = typeof route.query.redirect === 'string' ? route.query.redirect : '/';
    router.replace(dest);
  } catch (err) {
    error.value = err.message;
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="auth-card">
    <h1>Welcome back</h1>
    <p class="sub">Log in to your PaperDaily account.</p>

    <form @submit.prevent="submit">
      <label>
        Email
        <input
          v-model="email"
          type="email"
          autocomplete="email"
          required
          placeholder="Your Email"
        />
      </label>

      <label>
        Password
        <input
          v-model="password"
          type="password"
          autocomplete="current-password"
          required
          placeholder="At least 8 characters"
        />
      </label>

      <p v-if="error" class="error">{{ error }}</p>

      <button type="submit" :disabled="submitting">
        {{ submitting ? 'Logging in…' : 'Log in' }}
      </button>
    </form>

    <p class="switch">
      No account?
      <RouterLink to="/signup">Sign up</RouterLink>
    </p>
  </div>
</template>
