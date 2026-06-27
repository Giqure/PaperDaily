import { createRouter, createWebHistory } from 'vue-router';
import { auth } from './store.js';
import Home from './views/Home.vue';
import Login from './views/Login.vue';

const routes = [
  { path: '/', name: 'home', component: Home, meta: { requiresAuth: true } },
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
    return { name: 'home' };
  }
  return true;
});

export default router;
