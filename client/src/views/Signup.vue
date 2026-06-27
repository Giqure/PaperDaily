<script setup>
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { auth } from '../store.js';

const router = useRouter();

const email = ref('');
const name = ref('');
const password = ref('');
const error = ref('');
const submitting = ref(false);

const MIN_PASSWORD = 8; // mirror the server rule for instant feedback

async function submit() {
  error.value = '';
  if (password.value.length < MIN_PASSWORD) {
    error.value = `Password must be at least ${MIN_PASSWORD} characters.`;
    return;
  }
  submitting.value = true;
  try {
    await auth.signup(email.value.trim(), password.value, name.value.trim() || undefined);
    router.replace('/');
  } catch (err) {
    error.value = err.message;
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="auth-card">
    <h1>Create your account</h1>
    <p class="sub">Start your daily paper digest.</p>

    <form @submit.prevent="submit">
      <label>
        Email
        <input
          v-model="email"
          type="email"
          autocomplete="email"
          required
          placeholder="you@example.com"
        />
      </label>

      <label>
        Name <span class="optional">(optional)</span>
        <input
          v-model="name"
          type="text"
          autocomplete="name"
          placeholder="Ada Lovelace"
        />
      </label>

      <label>
        Password
        <input
          v-model="password"
          type="password"
          autocomplete="new-password"
          required
          minlength="8"
          placeholder="At least 8 characters"
        />
      </label>

      <p v-if="error" class="error">{{ error }}</p>

      <button type="submit" :disabled="submitting">
        {{ submitting ? 'Creating…' : 'Sign up' }}
      </button>
    </form>

    <p class="switch">
      Already have an account?
      <RouterLink to="/login">Log in</RouterLink>
    </p>
  </div>
</template>
