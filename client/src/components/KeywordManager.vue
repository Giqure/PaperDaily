<script setup>
import { ref, computed, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { subscriptionsApi } from '../api.js';

const { t } = useI18n();

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

// Management UI (catalog picker, author form, delete buttons) is collapsed by
// default — the sidebar reads as a clean scope nav until you choose to edit.
const editing = ref(false);

// Create-scope form.
const showForm = ref(false);
const form = ref({ name: '', queries: '', interests: '' });

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

async function createScope() {
  const name = form.value.name.trim();
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
      queries,
      interests: form.value.interests.trim(),
    });
    form.value = { name: '', queries: '', interests: '' };
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
            <span class="scope-nav-name">{{ sub.scope.name }}</span>
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

        <!-- Catalog picker -->
        <div v-if="available.length" class="library">
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
              + {{ sc.name }}
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
              {{ t('scopes.name') }}
              <input
                v-model="form.name"
                type="text"
                maxlength="80"
                :placeholder="t('scopes.namePlaceholder')"
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
