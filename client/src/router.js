import { createRouter, createWebHistory } from 'vue-router';
import { auth } from './store.js';
import Index from './views/Index.vue';
import Dashboard from './views/Dashboard.vue';
import Login from './views/Login.vue';

const routes = [
  { path: '/', name: 'index', component: Index },
  { path: '/dashboard', name: 'dashboard', component: Dashboard, meta: { requiresAuth: true } },
  { path: '/login', name: 'login', component: Login, meta: { guestOnly: true } },
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
    return { name: 'dashboard' };
  }
  return true;
});

export default router;
