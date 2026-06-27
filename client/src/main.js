import { createApp } from 'vue';
import App from './App.vue';
import router from './router.js';
import { auth } from './store.js';
import './styles.css';

// Restore the session before mounting so the first route guard sees the real
// auth state and we don't flash the login page on a logged-in reload.
auth.init().finally(() => {
  createApp(App).use(router).mount('#app');
});
