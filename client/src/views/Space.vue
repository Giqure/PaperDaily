<script setup>
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue';
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

// Scrollspy: the scope section currently nearest the top of the viewport.
const activeScope = ref('');
let observer = null;

// Group the daily feed by scope, in the order the user follows them. A paper is
// listed once, under the first followed scope it belongs to, so multi-scope
// papers don't duplicate across sections. Papers that match none of the named
// scopes (shouldn't normally happen) fall into a trailing "Other" group.
const dailyGroups = computed(() => {
  const groups = [];
  const placed = new Set();
  for (const name of dailyScopes.value) {
    const papers = daily.value.filter(
      (p) => !placed.has(p.id) && (p.scopes || []).includes(name)
    );
    papers.forEach((p) => placed.add(p.id));
    groups.push({ name, papers });
  }
  const rest = daily.value.filter((p) => !placed.has(p.id));
  if (rest.length) groups.push({ name: 'Other', papers: rest });
  return groups;
});

// Scope names that actually have papers today — used to dim empty nav entries.
const scopesWithPapers = computed(
  () => new Set(dailyGroups.value.filter((g) => g.papers.length).map((g) => g.name))
);

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
  // Record the dismissal but keep the card in place; it just reflects the new
  // state. It'll be gone on the next daily load.
  const prev = paper.state;
  paper.state = paper.state === 'dismissed' ? null : 'dismissed'; // optimistic, toggleable
  try {
    await papersApi.setState(paper.id, paper.state);
  } catch (err) {
    paper.state = prev; // revert on failure
    error.value = err.message;
  }
}

async function unsave(paper) {
  // Record the removal but keep the card visible; it just reflects that it's no
  // longer saved. It'll be gone on the next saved load.
  const prev = paper.state;
  paper.state = null; // optimistic
  try {
    await papersApi.setState(paper.id, null);
  } catch (err) {
    paper.state = prev; // revert on failure
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

// Smooth-scroll the main column to a scope's section (sidebar nav click).
function scrollToScope(name) {
  const el = document.querySelector(`[data-scope-section="${CSS.escape(name)}"]`);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// (Re)build the scrollspy: highlight whichever section's heading is closest to
// the top band of the viewport. Rebuilt whenever the grouped sections change.
function setupObserver() {
  if (observer) observer.disconnect();
  if (tab.value !== 'daily') return;
  const sections = Array.from(document.querySelectorAll('[data-scope-section]'));
  if (!sections.length) return;
  if (!activeScope.value) activeScope.value = sections[0].dataset.scopeSection;

  observer = new IntersectionObserver(
    (entries) => {
      // Pick the entry intersecting the top band, preferring the highest one.
      const visible = entries
        .filter((e) => e.isIntersecting)
        .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
      if (visible.length) {
        activeScope.value = visible[0].target.dataset.scopeSection;
      }
    },
    // Top band: a section is "active" while its heading sits in the upper
    // quarter of the viewport.
    { rootMargin: '0px 0px -75% 0px', threshold: 0 }
  );
  sections.forEach((s) => observer.observe(s));
}

watch([dailyGroups, tab], async () => {
  await nextTick();
  setupObserver();
});

onMounted(async () => {
  await loadDaily();
  await nextTick();
  setupObserver();
});

onBeforeUnmount(() => observer?.disconnect());
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

    <div class="space-layout">
      <!-- Main column: the daily / saved papers -->
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
              Follow some scopes in the sidebar to see your daily papers.
            </p>
            <p v-else-if="!daily.length" class="muted">
              No papers under your scopes right now. Check back tomorrow.
            </p>
            <template v-else>
              <section
                v-for="group in dailyGroups"
                v-show="group.papers.length"
                :key="group.name"
                :data-scope-section="group.name"
                class="scope-section"
              >
                <h2 class="scope-section-head">{{ group.name }}</h2>
                <div class="paper-list">
                  <PaperCard
                    v-for="p in group.papers"
                    :key="p.id"
                    :paper="p"
                    context="daily"
                    @save="save(p)"
                    @dismiss="dismiss(p)"
                  />
                </div>
              </section>
            </template>
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
                @save="save(p)"
                @dismiss="dismiss(p)"
                @unsave="unsave(p)"
              />
            </div>
          </template>
        </div>
      </section>

      <!-- Right rail: scope subscriptions + scrollspy nav -->
      <aside class="space-side">
        <KeywordManager
          :active-scope="activeScope"
          :scopes-with-papers="scopesWithPapers"
          @changed="loadDaily"
          @navigate="scrollToScope"
        />
      </aside>
    </div>
  </div>
</template>
