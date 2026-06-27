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
  } catch {
    state.user = null; // 401 = not logged in; any error means "anonymous"
  } finally {
    state.ready = true;
  }
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
};
