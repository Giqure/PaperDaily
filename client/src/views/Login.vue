<script setup>
import { ref } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { auth } from '../store.js';

const router = useRouter();
const route = useRoute();

const MIN_PASSWORD = 8; // mirror the server rule for instant feedback

// 'login'  → email + password, the default entry point
// 'signup' → email is known-new; confirm password to create the account
const stage = ref('login');

const email = ref('');
const password = ref('');
const confirm = ref('');
const error = ref('');
const submitting = ref(false);

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
    error.value = `Password must be at least ${MIN_PASSWORD} characters.`;
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
        error.value = 'Incorrect password for this account.';
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
    error.value = 'Passwords do not match.';
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
      error.value = 'This email was just registered. Please log in.';
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
}
</script>

<template>
  <div class="auth-card">
    <!-- Stage 1: log in (or detect a new email) -->
    <template v-if="stage === 'login'">
      <h1>PaperDaily</h1>
      <p class="sub">Log in, or enter a new email to create an account.</p>

      <form @submit.prevent="submitLogin">
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
            minlength="8"
            placeholder="At least 8 characters"
          />
        </label>

        <p v-if="error" class="error">{{ error }}</p>

        <button type="submit" :disabled="submitting">
          {{ submitting ? 'Continuing…' : 'Continue' }}
        </button>
      </form>
    </template>

    <!-- Stage 2: confirm signup for a new email -->
    <template v-else>
      <h1>Create your account</h1>
      <p class="sub">
        No account exists for <strong>{{ email }}</strong> yet. Confirm your
        password to sign up.
      </p>

      <form @submit.prevent="submitSignup">
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

        <label>
          Confirm password
          <input
            v-model="confirm"
            type="password"
            autocomplete="new-password"
            required
            minlength="8"
            placeholder="Re-enter your password"
          />
        </label>

        <p v-if="error" class="error">{{ error }}</p>

        <button type="submit" :disabled="submitting">
          {{ submitting ? 'Creating…' : 'Sign up' }}
        </button>
      </form>

      <p class="switch">
        <a href="#" @click.prevent="backToLogin">Use a different email</a>
      </p>
    </template>
  </div>
</template>
