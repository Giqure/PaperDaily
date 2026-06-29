<script setup>
import { ref } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { auth } from '../store.js';
import { authApi } from '../api.js';
import LanguageSwitcher from '../components/LanguageSwitcher.vue';

const { t } = useI18n();

const router = useRouter();
const route = useRoute();

const MIN_PASSWORD = 8; // mirror the server rule for instant feedback

// 'login'  → email + password, the default entry point
// 'signup' → email is known-new; confirm password to create the account
// 'forgot' → collect the account email and mail a reset link
const stage = ref('login');

const email = ref('');
const password = ref('');
const confirm = ref('');
const error = ref('');
const submitting = ref(false);
// Set after a reset link is requested, to show the "check your inbox" notice.
const resetSentTo = ref('');

// Only follow same-origin path redirects. `route.query.redirect` is fully
// attacker-controllable (e.g. ?redirect=https://evil.com or //evil.com), so an
// unchecked router.replace would be an open redirect. Require a leading single
// slash and reject protocol-relative ("//") and backslash tricks.
function safeRedirect() {
  const r = route.query.redirect;
  if (typeof r === 'string' && /^\/(?!\/)/.test(r) && !r.includes('\\')) {
    return r;
  }
  return '/space';
}

function go() {
  router.replace(safeRedirect());
}

// Stage 1: attempt login. Login returns 401 for both "wrong password" and
// "unknown email" (intentional), so on 401 we ask the server which case it is
// and branch: known email → password was wrong; new email → go collect a
// confirmation and sign up.
async function submitLogin() {
  error.value = '';
  if (password.value.length < MIN_PASSWORD) {
    error.value = t('login.errPasswordMin', { min: MIN_PASSWORD });
    return;
  }

  submitting.value = true;
  const mail = email.value.trim();
  try {
    await auth.login(mail, password.value);
    go();
  } catch (err) {
    if (err.status !== 401) {
      error.value = err.message; // 429 / 500 / network — surface, don't branch
      return;
    }
    try {
      const registered = await auth.checkEmail(mail);
      if (registered) {
        error.value = t('login.errWrongPassword');
      } else {
        // New email — move to the signup confirmation stage, keeping the
        // password the user already typed.
        stage.value = 'signup';
        confirm.value = '';
      }
    } catch (checkErr) {
      error.value = checkErr.message;
    }
  } finally {
    submitting.value = false;
  }
}

// Stage 2: the email is known-new; require the user to re-type the password
// before we create the account.
async function submitSignup() {
  error.value = '';
  if (password.value !== confirm.value) {
    error.value = t('login.errPasswordMismatch');
    return;
  }

  submitting.value = true;
  try {
    await auth.signup(email.value.trim(), password.value);
    go();
  } catch (err) {
    // 409 = someone registered this email between stage 1 and now; send them
    // back to log in.
    if (err.status === 409) {
      error.value = t('login.errJustRegistered');
      backToLogin();
    } else {
      error.value = err.message;
    }
  } finally {
    submitting.value = false;
  }
}

function backToLogin() {
  stage.value = 'login';
  confirm.value = '';
  error.value = '';
  resetSentTo.value = '';
}

// Move to the forgot-password stage, carrying over any email already typed.
function showForgot() {
  stage.value = 'forgot';
  error.value = '';
  resetSentTo.value = '';
}

// Request a reset link. The server responds the same whether or not the email
// exists (anti-enumeration), so we always show the same confirmation.
async function submitForgot() {
  error.value = '';
  const mail = email.value.trim();
  submitting.value = true;
  try {
    await authApi.forgotPassword(mail);
    resetSentTo.value = mail;
  } catch (err) {
    error.value = err.message;
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="auth-card">
    <!-- Stage 1: log in (or detect a new email) -->
    <template v-if="stage === 'login'">
      <h1>{{ t('login.title') }}</h1>
      <p class="sub">{{ t('login.sub') }}</p>

      <form @submit.prevent="submitLogin">
        <label>
          {{ t('login.email') }}
          <input
            v-model="email"
            type="email"
            autocomplete="email"
            required
            :placeholder="t('login.emailPlaceholder')"
          />
        </label>

        <label>
          {{ t('login.password') }}
          <input
            v-model="password"
            type="password"
            autocomplete="current-password"
            required
            minlength="8"
            :placeholder="t('login.passwordPlaceholder')"
          />
        </label>

        <p v-if="error" class="error">{{ error }}</p>

        <button type="submit" :disabled="submitting">
          {{ submitting ? t('login.continuing') : t('login.continue') }}
        </button>
        <p class="tip">{{ t('login.tip') }}</p>
      </form>

      <p class="switch">
        <a href="#" @click.prevent="showForgot">{{ t('login.forgot') }}</a>
      </p>
    </template>

    <!-- Stage 2: confirm signup for a new email -->
    <template v-else-if="stage === 'signup'">
      <h1>{{ t('login.createTitle') }}</h1>
      <p class="sub">
        <i18n-t keypath="login.createSub" tag="span">
          <template #email><strong>{{ email }}</strong></template>
        </i18n-t>
      </p>

      <form @submit.prevent="submitSignup">
        <label>
          {{ t('login.password') }}
          <input
            v-model="password"
            type="password"
            autocomplete="new-password"
            required
            minlength="8"
            :placeholder="t('login.passwordPlaceholder')"
          />
        </label>

        <label>
          {{ t('login.confirmPassword') }}
          <input
            v-model="confirm"
            type="password"
            autocomplete="new-password"
            required
            minlength="8"
            :placeholder="t('login.confirmPlaceholder')"
          />
        </label>

        <p v-if="error" class="error">{{ error }}</p>

        <button type="submit" :disabled="submitting">
          {{ submitting ? t('login.creating') : t('login.signUp') }}
        </button>
      </form>

      <p class="switch">
        <a href="#" @click.prevent="backToLogin">{{ t('login.useDifferentEmail') }}</a>
      </p>
    </template>

    <!-- Stage 3: forgot password — mail a reset link -->
    <template v-else>
      <h1>{{ t('login.forgotTitle') }}</h1>

      <!-- After a request, show the anti-enumeration confirmation only. -->
      <template v-if="resetSentTo">
        <p class="sub">
          <i18n-t keypath="login.resetSent" tag="span">
            <template #email><strong>{{ resetSentTo }}</strong></template>
          </i18n-t>
        </p>
        <button type="button" @click="backToLogin">{{ t('login.backToLogin') }}</button>
      </template>

      <template v-else>
        <p class="sub">{{ t('login.forgotSub') }}</p>

        <form @submit.prevent="submitForgot">
          <label>
            {{ t('login.email') }}
            <input
              v-model="email"
              type="email"
              autocomplete="email"
              required
              :placeholder="t('login.emailPlaceholder')"
            />
          </label>

          <p v-if="error" class="error">{{ error }}</p>

          <button type="submit" :disabled="submitting">
            {{ submitting ? t('login.sending') : t('login.sendResetLink') }}
          </button>
        </form>

        <p class="switch">
          <a href="#" @click.prevent="backToLogin">{{ t('login.backToLogin') }}</a>
        </p>
      </template>
    </template>

    <LanguageSwitcher class="auth-lang" />
  </div>
</template>

<style scoped>
.tip {
  /* The form is a flex column with gap:1.1rem; pull the tip up so it reads as
     a caption under the button rather than a full gap away. */
  margin-top: -0.7rem;
  font-size: 0.85rem;
  color: var(--ink-faint, #807d76);
  text-align: center;
}
.auth-lang {
  margin-top: 1.5rem;
}
</style>
