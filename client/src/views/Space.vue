<script setup>
import { ref, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { auth } from '../store.js';
import { papersApi } from '../api.js';
import KeywordManager from '../components/KeywordManager.vue';
import PaperCard from '../components/PaperCard.vue';

const router = useRouter();
const loggingOut = ref(false);

const tab = ref('daily'); // 'daily' | 'saved'
const daily = ref([]);
const saved = ref([]);
const dailyScopes = ref([]);
const loadingDaily = ref(false);
const loadingSaved = ref(false);
const error = ref('');

async function loadDaily() {
  loadingDaily.value = true;
  error.value = '';
  try {
    const res = await papersApi.daily();
    daily.value = res.papers;
    dailyScopes.value = res.scopes;
  } catch (err) {
    error.value = err.message;
  } finally {
    loadingDaily.value = false;
  }
}

async function loadSaved() {
  loadingSaved.value = true;
  error.value = '';
  try {
    const res = await papersApi.saved();
    saved.value = res.papers;
  } catch (err) {
    error.value = err.message;
  } finally {
    loadingSaved.value = false;
  }
}

async function save(paper) {
  try {
    await papersApi.setState(paper.id, 'saved');
    paper.state = 'saved'; // optimistic
  } catch (err) {
    error.value = err.message;
  }
}

async function dismiss(paper) {
  try {
    await papersApi.setState(paper.id, 'dismissed');
    daily.value = daily.value.filter((p) => p.id !== paper.id);
  } catch (err) {
    error.value = err.message;
  }
}

async function unsave(paper) {
  try {
    await papersApi.setState(paper.id, null);
    saved.value = saved.value.filter((p) => p.id !== paper.id);
  } catch (err) {
    error.value = err.message;
  }
}

function switchTab(next) {
  tab.value = next;
  if (next === 'saved' && !saved.value.length) loadSaved();
}

async function logout() {
  loggingOut.value = true;
  try {
    await auth.logout();
    router.replace('/');
  } finally {
    loggingOut.value = false;
  }
}

onMounted(loadDaily);
</script>

<template>
  <div class="space">
    <header class="space-head">
      <div>
        <h1>Your space</h1>
        <p class="who">{{ auth.state.user.name || auth.state.user.email }}</p>
      </div>
      <button class="ghost" :disabled="loggingOut" @click="logout">
        {{ loggingOut ? 'Logging out…' : 'Log out' }}
      </button>
    </header>

    <KeywordManager @changed="loadDaily" />

    <section class="panel">
      <div class="tabs">
        <button :class="{ active: tab === 'daily' }" @click="switchTab('daily')">
          Daily papers
        </button>
        <button :class="{ active: tab === 'saved' }" @click="switchTab('saved')">
          Saved
        </button>
      </div>

      <p v-if="error" class="error">{{ error }}</p>

      <!-- Daily -->
      <div v-show="tab === 'daily'">
        <div v-if="loadingDaily" class="muted">Loading papers…</div>
        <template v-else>
          <p v-if="!dailyScopes.length" class="muted">
            Follow some scopes above to see your daily papers.
          </p>
          <p v-else-if="!daily.length" class="muted">
            No papers under your scopes right now. Check back tomorrow.
          </p>
          <div v-else class="paper-list">
            <PaperCard
              v-for="p in daily"
              :key="p.id"
              :paper="p"
              context="daily"
              @save="save(p)"
              @dismiss="dismiss(p)"
            />
          </div>
        </template>
      </div>

      <!-- Saved -->
      <div v-show="tab === 'saved'">
        <div v-if="loadingSaved" class="muted">Loading…</div>
        <template v-else>
          <p v-if="!saved.length" class="muted">No saved papers yet.</p>
          <div v-else class="paper-list">
            <PaperCard
              v-for="p in saved"
              :key="p.id"
              :paper="p"
              context="saved"
              @unsave="unsave(p)"
            />
          </div>
        </template>
      </div>
    </section>
  </div>
</template>
