<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute } from 'vue-router';
import { auth } from '../store.js';
import { subscriptionsApi, reportsApi } from '../api.js';
import PaperCard from '../components/PaperCard.vue';
import { scopeLabel } from '../scopeLabel.js';
import { intlLocale } from '../i18n/index.js';

const { t, locale } = useI18n();
const route = useRoute();

// Today in the browser's local time, as YYYY-MM-DD, for the date input's max
// and default. The server validates against Asia/Shanghai's today; picking the
// local "today" stays within that bound in every timezone west of UTC+8 and is
// corrected by the server otherwise.
function todayStr() {
  const now = new Date();
  const off = now.getTimezoneOffset() * 60000;
  return new Date(now.getTime() - off).toISOString().slice(0, 10);
}

const catalog = ref([]);
const loadingCatalog = ref(true);
const selected = ref(new Set());
const date = ref(todayStr());
const maxDate = todayStr();

const error = ref('');
const status = ref(''); // '' | 'pending' | 'running' | 'done' | 'failed'
const queuePosition = ref(0); // jobs ahead in the global queue while pending
const reusedIds = ref([]);
const papers = ref([]);
const resultDate = ref('');
const loadingResult = ref(false);

let pollTimer = null;

const running = computed(() => status.value === 'pending' || status.value === 'running');

// Localized display label for a scope.
function label(scope) {
  return scopeLabel(scope, locale.value);
}

// Resolve a canonical scope name (carried on each paper) to its localized badge
// label, via the catalog. Falls back to the canonical name.
const scopeByName = computed(() => {
  const map = new Map();
  for (const sc of catalog.value) map.set(sc.name, sc);
  return map;
});
function scopeBadgeLabel(name) {
  const sc = scopeByName.value.get(name);
  return sc ? scopeLabel(sc, locale.value) : name;
}

// Names of the scopes that were reused (already had a digest that date), for the
// "already reported" tip.
const reusedNames = computed(() => {
  const byId = new Map(catalog.value.map((sc) => [sc.id, sc]));
  return reusedIds.value.map((id) => (byId.get(id) ? label(byId.get(id)) : `#${id}`));
});

function formatDate(d) {
  if (!d) return '';
  const parsed = new Date(`${d}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return d;
  return parsed.toLocaleDateString(intlLocale(locale.value), {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function toggle(scopeId) {
  const next = new Set(selected.value);
  if (next.has(scopeId)) next.delete(scopeId);
  else next.add(scopeId);
  selected.value = next;
}

function parseScopeIdsParam(raw) {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return [];
  const ids = [];
  const seen = new Set();
  for (const part of String(value).split(',')) {
    const id = Number(part);
    if (!Number.isInteger(id) || id < 1 || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

async function loadCatalog() {
  loadingCatalog.value = true;
  try {
    const res = await subscriptionsApi.catalog();
    catalog.value = res.catalog;
    await loadLinkedReport();
  } catch (err) {
    error.value = err.message;
  } finally {
    loadingCatalog.value = false;
  }
}

async function loadLinkedReport() {
  const linkedDate = Array.isArray(route.query.date) ? route.query.date[0] : route.query.date;
  const scopeIds = parseScopeIdsParam(route.query.scopeIds);
  if (!linkedDate || !scopeIds.length) return;

  const visibleIds = new Set(catalog.value.map((sc) => sc.id));
  const filtered = scopeIds.filter((id) => visibleIds.has(id));
  if (!filtered.length) return;

  date.value = linkedDate;
  selected.value = new Set(filtered);
  status.value = 'done';
  await loadResult(linkedDate, filtered);
}

async function generate() {
  error.value = '';
  papers.value = [];
  reusedIds.value = [];
  const scopeIds = [...selected.value];
  if (!date.value || !scopeIds.length) {
    error.value = t('report.errNeedDateAndScope');
    return;
  }
  try {
    status.value = 'pending';
    const { jobId } = await reportsApi.generate(date.value, scopeIds);
    poll(jobId, scopeIds);
  } catch (err) {
    status.value = '';
    error.value = err.message;
  }
}

// Poll the job until it finishes, then load the result. `scopeIds` is captured
// so a change to the selection while a job runs doesn't affect the fetch.
function poll(jobId, scopeIds) {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => {
    try {
      const job = await reportsApi.job(jobId);
      status.value = job.status;
      queuePosition.value = job.queuePosition || 0;
      if (job.status === 'done') {
        reusedIds.value = job.reusedScopeIds || [];
        await loadResult(job.targetDate, scopeIds);
      } else if (job.status === 'failed') {
        error.value = job.error || t('report.statusFailed');
      } else {
        poll(jobId, scopeIds);
      }
    } catch (err) {
      status.value = 'failed';
      error.value = err.message;
    }
  }, 3000);
}

async function loadResult(forDate, scopeIds) {
  loadingResult.value = true;
  try {
    const res = await reportsApi.result(forDate, scopeIds);
    papers.value = res.papers;
    resultDate.value = res.date;
  } catch (err) {
    error.value = err.message;
  } finally {
    loadingResult.value = false;
  }
}

onMounted(loadCatalog);
onBeforeUnmount(() => clearTimeout(pollTimer));
</script>

<template>
  <div class="space">
    <header class="space-head">
      <div>
        <h1>{{ t('report.title') }}</h1>
        <p class="who">{{ auth.state.user.name || auth.state.user.email }}</p>
      </div>
      <div class="space-head-actions">
        <RouterLink class="ghost" to="/space">{{ t('report.backToSpace') }}</RouterLink>
      </div>
    </header>

    <section class="panel">
      <p class="muted">{{ t('report.intro') }}</p>
      <p v-if="error" class="error">{{ error }}</p>

      <label class="field">
        <span class="field-label">{{ t('report.dateLabel') }}</span>
        <input v-model="date" type="date" :max="maxDate" :disabled="running" />
      </label>

      <div class="field">
        <span class="field-label">{{ t('report.selectScopes') }}</span>
        <p v-if="loadingCatalog" class="muted">{{ t('report.loading') }}</p>
        <div v-else class="chips">
          <button
            v-for="sc in catalog"
            :key="sc.id"
            class="chip add"
            :class="{ picked: selected.has(sc.id) }"
            :disabled="running"
            :title="sc.interests"
            @click="toggle(sc.id)"
          >
            {{ label(sc) }}
          </button>
        </div>
      </div>

      <div class="form-actions">
        <button :disabled="running || loadingCatalog" @click="generate">
          {{ running ? t('report.generating') : t('report.generate') }}
        </button>
        <span v-if="status === 'pending' && queuePosition > 0" class="muted">
          {{ t('report.statusQueued', { n: queuePosition }) }}
        </span>
        <span v-else-if="status === 'running' || status === 'pending'" class="muted">
          {{ t('report.statusRunning') }}
        </span>
      </div>
    </section>

    <!-- Result panel -->
    <section v-if="status === 'done'" class="panel">
      <p v-if="reusedNames.length" class="muted reuse-tip">
        {{ t('report.alreadyReported', { scopes: reusedNames.join('、') }) }}
      </p>
      <div v-if="loadingResult" class="muted">{{ t('report.loading') }}</div>
      <template v-else>
        <p v-if="!papers.length" class="muted">{{ t('report.noResults') }}</p>
        <section v-else class="scope-section">
          <h2 class="scope-section-head">{{ formatDate(resultDate) }}</h2>
          <div class="paper-list">
            <PaperCard
              v-for="p in papers"
              :key="p.id"
              :paper="p"
              context="daily"
              :show-scopes="true"
              :label-scope="scopeBadgeLabel"
            />
          </div>
        </section>
      </template>
    </section>
  </div>
</template>

<style scoped>
.space-head-actions {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}
.field {
  display: block;
  margin: 1rem 0;
}
.field-label {
  display: block;
  margin-bottom: 0.4rem;
  font-weight: 500;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}
.chip.add.picked {
  background: var(--navy);
  border-style: solid;
  border-color: var(--navy);
  color: #fff;
}
.reuse-tip {
  margin-bottom: 0.75rem;
}
</style>
