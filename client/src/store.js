// Minimal global auth state — a single reactive object shared across the app.
// No Pinia needed for one small store. `ready` tells route guards when the
// initial /me probe has resolved so we don't flash the login page on reload.
import { reactive, readonly } from 'vue';
import { authApi } from './api.js';

const state = reactive({
  user: null,
  ready: false,
});

/** Probe the session once on app boot to restore the logged-in user. */
async function init() {
  try {
    const { user } = await authApi.me();
    state.user = user;
  } catch (err) {
    // Only a 401 definitively means "not authenticated" — clear the user.
    // A 5xx / network error means we *don't know*; leave existing state alone
    // rather than silently logging a real user out on a transient hiccup.
    if (err.status === 401) state.user = null;
  } finally {
    state.ready = true;
  }
}

async function checkEmail(email) {
  const { registered } = await authApi.checkEmail(email);
  return registered;
}

async function signup(email, password, name) {
  const { user } = await authApi.signup(email, password, name);
  state.user = user;
  return user;
}

async function login(email, password) {
  const { user } = await authApi.login(email, password);
  state.user = user;
  return user;
}

async function logout() {
  await authApi.logout();
  state.user = null;
}

export const auth = {
  state: readonly(state),
  init,
  signup,
  login,
  logout,
  checkEmail,
};
