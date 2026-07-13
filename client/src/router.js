import { createRouter, createWebHistory } from 'vue-router';
import { auth } from './store.js';
import Index from './views/Index.vue';
import Space from './views/Space.vue';
import Report from './views/Report.vue';
import Login from './views/Login.vue';
import ResetPassword from './views/ResetPassword.vue';

const routes = [
  { path: '/', name: 'index', component: Index },
  { path: '/space', name: 'space', component: Space, meta: { requiresAuth: true } },
  { path: '/report', name: 'report', component: Report, meta: { requiresAuth: true } },
  { path: '/login', name: 'login', component: Login, meta: { guestOnly: true } },
  // Reached via the mailed reset link. Open to anyone with a valid token; the
  // token (not a session) authorizes the action, so it's not guestOnly — a
  // logged-in user following the link from email still lands here.
  { path: '/reset-password', name: 'reset-password', component: ResetPassword },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
});

// Global guard. `auth.state.ready` is set after the initial /me probe in
// main.js, so by the time navigation runs we know the real auth state.
router.beforeEach((to) => {
  const loggedIn = !!auth.state.user;

  if (to.meta.requiresAuth && !loggedIn) {
    return { name: 'login', query: { redirect: to.fullPath } };
  }
  if (to.meta.guestOnly && loggedIn) {
    return { name: 'space' };
  }
  return true;
});

export default router;
