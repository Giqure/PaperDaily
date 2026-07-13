<script setup>
import { ref, computed, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { subscriptionsApi } from '../api.js';
import { scopeLabel } from '../scopeLabel.js';

const { t, locale } = useI18n();

// Minimum scope-name length, mirrored by the server (subscriptions/routes.js).
// Names shorter than this are too vague to query or auto-fill on.
const MIN_NAME_LEN = 8;

const props = defineProps({
  // Scope name currently in view (scrollspy) — highlighted in the nav.
  activeScope: { type: String, default: '' },
  // Set of scope names that have papers today — others are dimmed.
  scopesWithPapers: { type: Object, default: () => new Set() },
  // Whether the scope list acts as scrollspy nav (daily tab). When false the
  // list is plain: no active rail, no dimming, no click-to-scroll.
  navEnabled: { type: Boolean, default: true },
});

const emit = defineEmits(['changed', 'navigate']);

const subscriptions = ref([]);
const catalog = ref([]);
const authored = ref({ used: 0, max: 3 });
const loading = ref(true);
const submitting = ref(false);
const error = ref('');

// True while the AI fills the queries/interests fields from the name.
const suggesting = ref(false);

// Management UI (catalog picker, author form, delete buttons) is collapsed by
// default — the sidebar reads as a clean scope nav until you choose to edit.
const editing = ref(false);

// Create-scope form. The user types in one language; the AI fills both labels.
// `name` is the canonical key (what they typed / the AI's zh name); nameEn/nameZh
// are the localized display labels.
const showForm = ref(false);
const form = ref({ name: '', nameEn: '', nameZh: '', queries: '', interests: '' });

// Localized display label for a scope, for the active locale.
function label(scope) {
  return scopeLabel(scope, locale.value);
}

// Mirror the server's normalizeName (subscriptions/routes.js): trim and collapse
// internal whitespace. Padding like "1    1" must not game the length check —
// the server stores "1 1" (length 3), so we measure the same way.
function normalizeName(raw) {
  return String(raw ?? '').trim().replace(/\s+/g, ' ');
}

const normalizedName = computed(() => normalizeName(form.value.name));

// Scope ids already followed, to hide them from the catalog picker.
const followedIds = computed(
  () => new Set(subscriptions.value.map((s) => s.scope.id))
);

// Catalog scopes the user hasn't followed yet.
const available = computed(() =>
  catalog.value.filter((sc) => !followedIds.value.has(sc.id))
);

const atAuthorCap = computed(() => authored.value.used >= authored.value.max);

function hasPapers(name) {
  return props.scopesWithPapers.has(name);
}

// In nav mode, scopes with no papers today are inert/dimmed. Outside nav mode
// (e.g. the All papers tab) every scope reads as a plain, active entry.
function navItemDisabled(name) {
  return props.navEnabled && !hasPapers(name);
}

async function load() {
  loading.value = true;
  try {
    const [subs, cat] = await Promise.all([
      subscriptionsApi.list(),
      subscriptionsApi.catalog(),
    ]);
    subscriptions.value = subs.subscriptions;
    authored.value = subs.authored;
    catalog.value = cat.catalog;
  } catch (err) {
    error.value = err.message;
  } finally {
    loading.value = false;
  }
}

async function follow(scopeId) {
  error.value = '';
  submitting.value = true;
  try {
    await subscriptionsApi.add(scopeId);
    await load();
    emit('changed');
  } catch (err) {
    error.value = err.message;
  } finally {
    submitting.value = false;
  }
}

// Ask the AI to assess + rewrite the name (both languages) and fill the
// queries + interests fields.
async function suggestFields() {
  const name = normalizedName.value;
  if (name.length < MIN_NAME_LEN) {
    error.value = t('scopes.suggestNeedsName');
    return;
  }
  error.value = '';
  suggesting.value = true;
  try {
    const { nameZh, nameEn, queries, interests } =
      await subscriptionsApi.suggestScope(name);
    // The AI rewrites the name into refined bilingual labels — write both back.
    // The canonical name follows the locale's label so the stored key matches
    // what the user is reading.
    if (nameZh) form.value.nameZh = nameZh;
    if (nameEn) form.value.nameEn = nameEn;
    // Mirror scopeLabel: only "all English" reads the English label; every other
    // mode (zh-CN, en) shows the Chinese one. Keep the canonical name in step.
    const preferred = locale.value === 'en-all' ? nameEn : nameZh;
    if (preferred) form.value.name = preferred;
    // queries arrives as an array; the textarea is one-per-line.
    form.value.queries = queries.join('\n');
    form.value.interests = interests || '';
  } catch (err) {
    error.value = err.status === 503 ? t('scopes.suggestFailed') : err.message;
  } finally {
    suggesting.value = false;
  }
}

async function createScope() {
  const name = form.value.name.trim();
  const nameEn = form.value.nameEn.trim();
  const nameZh = form.value.nameZh.trim();
  // One query per line.
  const queries = form.value.queries
    .split('\n')
    .map((q) => q.trim())
    .filter(Boolean);
  if (!name || !queries.length) {
    error.value = t('scopes.errNameQueryRequired');
    return;
  }
  error.value = '';
  submitting.value = true;
  try {
    await subscriptionsApi.createScope({
      name,
      nameEn,
      nameZh,
      queries,
      interests: form.value.interests.trim(),
    });
    form.value = { name: '', nameEn: '', nameZh: '', queries: '', interests: '' };
    showForm.value = false;
    await load();
    emit('changed');
  } catch (err) {
    error.value = err.message;
  } finally {
    submitting.value = false;
  }
}

async function remove(sub) {
  error.value = '';
  try {
    await subscriptionsApi.remove(sub.id);
    await load();
    emit('changed');
  } catch (err) {
    error.value = err.message;
  }
}

onMounted(load);
defineExpose({ reload: load });
</script>

<template>
  <section class="panel">
    <header class="panel-head">
      <h2>{{ t('scopes.title') }}</h2>
      <button class="link-btn" @click="editing = !editing">
        {{ editing ? t('scopes.done') : t('scopes.edit') }}
      </button>
    </header>

    <div v-if="loading" class="muted">{{ t('scopes.loading') }}</div>

    <template v-else>
      <p v-if="error" class="error">{{ error }}</p>

      <!-- Followed scopes = scrollspy nav (daily tab) / plain list elsewhere -->
      <nav v-if="subscriptions.length" class="scope-nav" :class="{ plain: !navEnabled }">
        <div
          v-for="sub in subscriptions"
          :key="sub.id"
          class="scope-nav-item"
          :class="{
            active: navEnabled && sub.scope.name === activeScope,
            empty: navEnabled && !hasPapers(sub.scope.name),
          }"
        >
          <button
            class="scope-nav-link"
            :disabled="navItemDisabled(sub.scope.name)"
            :title="sub.scope.interests"
            @click="navEnabled && emit('navigate', sub.scope.name)"
          >
            <span class="scope-nav-name">{{ label(sub.scope) }}</span>
          </button>
          <button
            v-if="editing"
            class="chip-x"
            :title="t('scopes.unfollow')"
            :aria-label="t('scopes.unfollowScope')"
            @click="remove(sub)"
          >
            ×
          </button>
        </div>
      </nav>
      <p v-else class="muted">{{ t('scopes.none') }}</p>

      <!-- Management — collapsed unless editing -->
      <template v-if="editing">
        <div class="edit-meta">
          <span class="budget" :class="{ full: atAuthorCap }">
            {{ t('scopes.authored', { used: authored.used, max: authored.max }) }}
          </span>
        </div>

        <!-- Catalog picker — collapsed while authoring a scope -->
        <div v-if="available.length && !showForm" class="library">
          <h3>{{ t('scopes.fromCatalog') }}</h3>
          <div class="chips">
            <button
              v-for="sc in available"
              :key="sc.id"
              class="chip add"
              :disabled="submitting"
              :title="sc.interests"
              @click="follow(sc.id)"
            >
              + {{ label(sc) }}
            </button>
          </div>
        </div>

        <!-- Author a new scope -->
        <div class="author">
          <button
            v-if="!showForm"
            class="ghost sm"
            :disabled="atAuthorCap"
            :title="atAuthorCap ? t('scopes.authorCapTitle') : ''"
            @click="showForm = true"
          >
            {{ t('scopes.authorScope') }}
          </button>

          <form v-else class="scope-form" @submit.prevent="createScope">
            <label>
              <span class="label-row">
                {{ t('scopes.name') }}
                <button
                  type="button"
                  class="suggest-btn"
                  :disabled="submitting || suggesting || normalizedName.length < MIN_NAME_LEN"
                  :title="t('scopes.suggest')"
                  :aria-label="t('scopes.suggest')"
                  @click="suggestFields"
                >
                  <span v-if="suggesting" class="suggest-spinner" aria-hidden="true" />
                  <svg
                    v-else
                    class="suggest-icon"
                    viewBox="0 0 24 24"
                    width="15"
                    height="15"
                    fill="currentColor"
                    aria-hidden="true"
                  >
                    <path
                      d="M11 2.5l1.6 4.3 4.3 1.6-4.3 1.6L11 14.3 9.4 10 5.1 8.4 9.4 6.8 11 2.5zM18 13l.9 2.4 2.4.9-2.4.9-.9 2.4-.9-2.4-2.4-.9 2.4-.9L18 13z"
                    />
                  </svg>
                </button>
              </span>
              <input
                v-model="form.name"
                type="text"
                :minlength="MIN_NAME_LEN"
                maxlength="80"
                :placeholder="t('scopes.namePlaceholder')"
                :disabled="submitting"
              />
            </label>
            <label>
              {{ t('scopes.nameEn') }} <small>{{ t('scopes.nameLocaleHint') }}</small>
              <input
                v-model="form.nameEn"
                type="text"
                maxlength="80"
                :placeholder="t('scopes.nameEnPlaceholder')"
                :disabled="submitting"
              />
            </label>
            <label>
              {{ t('scopes.nameZh') }} <small>{{ t('scopes.nameLocaleHint') }}</small>
              <input
                v-model="form.nameZh"
                type="text"
                maxlength="80"
                :placeholder="t('scopes.nameZhPlaceholder')"
                :disabled="submitting"
              />
            </label>
            <label>
              {{ t('scopes.queries') }} <small>{{ t('scopes.queriesHint') }}</small>
              <textarea
                v-model="form.queries"
                rows="4"
                placeholder="all:dexterous AND all:manipulation&#10;all:grasping"
                :disabled="submitting"
              />
            </label>
            <label>
              {{ t('scopes.interests') }} <small>{{ t('scopes.interestsHint') }}</small>
              <textarea
                v-model="form.interests"
                rows="2"
                :placeholder="t('scopes.interestsPlaceholder')"
                :disabled="submitting"
              />
            </label>
            <div class="form-actions">
              <button type="submit" :disabled="submitting">
                {{ submitting ? t('scopes.creating') : t('scopes.create') }}
              </button>
              <button
                type="button"
                class="ghost sm"
                :disabled="submitting"
                @click="showForm = false"
              >
                {{ t('scopes.cancel') }}
              </button>
            </div>
          </form>
        </div>
      </template>
    </template>
  </section>
</template>
