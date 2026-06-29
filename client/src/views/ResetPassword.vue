<script setup>
import { ref, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { authApi } from '../api.js';
import LanguageSwitcher from '../components/LanguageSwitcher.vue';

const { t } = useI18n();
const route = useRoute();
const router = useRouter();

const MIN_PASSWORD = 8; // mirror the server rule for instant feedback

// 'checking' → validating the token from the link
// 'invalid'  → token missing / expired / already used
// 'form'     → token good; collect the new password
// 'success'  → password changed
const stage = ref('checking');

const token = ref('');
const password = ref('');
const confirm = ref('');
const error = ref('');
const submitting = ref(false);

onMounted(async () => {
  token.value = typeof route.query.token === 'string' ? route.query.token : '';
  if (!token.value) {
    stage.value = 'invalid';
    return;
  }
  try {
    const { valid } = await authApi.validateResetToken(token.value);
    stage.value = valid ? 'form' : 'invalid';
  } catch {
    // Network/5xx — treat as invalid so the user gets a clear path forward
    // rather than a stuck spinner.
    stage.value = 'invalid';
  }
});

async function submit() {
  error.value = '';
  if (password.value.length < MIN_PASSWORD) {
    error.value = t('reset.errPasswordMin', { min: MIN_PASSWORD });
    return;
  }
  if (password.value !== confirm.value) {
    error.value = t('reset.errPasswordMismatch');
    return;
  }

  submitting.value = true;
  try {
    await authApi.resetPassword(token.value, password.value);
    stage.value = 'success';
  } catch (err) {
    // A 400 here means the token expired between validation and submit; surface
    // the server message and drop back to the invalid state so they re-request.
    if (err.status === 400) {
      stage.value = 'invalid';
      error.value = '';
    } else {
      error.value = err.message;
    }
  } finally {
    submitting.value = false;
  }
}

function goHome() {
  router.replace({ name: 'index' });
}
</script>

<template>
  <div class="auth-card">
    <!-- Validating the link -->
    <template v-if="stage === 'checking'">
      <h1>{{ t('reset.title') }}</h1>
      <p class="sub">{{ t('reset.checking') }}</p>
    </template>

    <!-- Bad/expired link -->
    <template v-else-if="stage === 'invalid'">
      <h1>{{ t('reset.title') }}</h1>
      <p class="sub">{{ t('reset.invalid') }}</p>
    </template>

    <!-- Success -->
    <template v-else-if="stage === 'success'">
      <h1>{{ t('reset.successTitle') }}</h1>
      <p class="sub">{{ t('reset.successSub') }}</p>
      <button type="button" @click="goHome">{{ t('reset.goHome') }}</button>
    </template>

    <!-- New-password form -->
    <template v-else>
      <h1>{{ t('reset.title') }}</h1>
      <p class="sub">{{ t('reset.sub') }}</p>

      <form @submit.prevent="submit">
        <label>
          {{ t('reset.newPassword') }}
          <input
            v-model="password"
            type="password"
            autocomplete="new-password"
            required
            minlength="8"
            :placeholder="t('reset.newPasswordPlaceholder')"
          />
        </label>

        <label>
          {{ t('reset.confirmPassword') }}
          <input
            v-model="confirm"
            type="password"
            autocomplete="new-password"
            required
            minlength="8"
            :placeholder="t('reset.confirmPlaceholder')"
          />
        </label>

        <p v-if="error" class="error">{{ error }}</p>

        <button type="submit" :disabled="submitting">
          {{ submitting ? t('reset.submitting') : t('reset.submit') }}
        </button>
      </form>
    </template>

    <LanguageSwitcher class="auth-lang" />
  </div>
</template>

<style scoped>
.auth-lang {
  margin-top: 1.5rem;
}
</style>
