<script setup>
import { ref, computed, onMounted } from 'vue';
import { subscriptionsApi } from '../api.js';

const emit = defineEmits(['changed']);

const subscriptions = ref([]);
const catalog = ref([]);
const authored = ref({ used: 0, max: 3 });
const loading = ref(true);
const submitting = ref(false);
const error = ref('');

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
    error.value = 'A name and at least one query are required.';
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
      <h2>Scopes</h2>
      <span class="budget" :class="{ full: atAuthorCap }">
        {{ authored.used }}/{{ authored.max }} authored
      </span>
    </header>

    <p class="hint">
      Subscribe to a scope to shape your daily digest. Each scope is a set of
      arXiv queries the system collects against every morning. Pick from the
      catalog, or author a new scope — it joins the shared catalog for everyone,
      and you can introduce up to {{ authored.max }}.
    </p>

    <p v-if="error" class="error">{{ error }}</p>

    <div v-if="loading" class="muted">Loading…</div>

    <template v-else>
      <!-- Followed scopes -->
      <div v-if="subscriptions.length" class="chips">
        <span
          v-for="sub in subscriptions"
          :key="sub.id"
          class="chip"
          :class="{ custom: sub.scope.isCustom }"
          :title="sub.scope.interests"
        >
          {{ sub.scope.name }}
          <button
            class="chip-x"
            title="Unfollow"
            @click="remove(sub)"
            aria-label="Unfollow scope"
          >
            ×
          </button>
        </span>
      </div>
      <p v-else class="muted">You're not following any scopes yet.</p>

      <!-- Catalog picker -->
      <div v-if="available.length" class="library">
        <h3>From the catalog</h3>
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
          :title="atAuthorCap ? 'You have reached your authored-scope limit.' : ''"
          @click="showForm = true"
        >
          + Author a scope
        </button>

        <form v-else class="scope-form" @submit.prevent="createScope">
          <label>
            Name
            <input
              v-model="form.name"
              type="text"
              maxlength="80"
              placeholder="e.g. 灵巧手与操作"
              :disabled="submitting"
            />
          </label>
          <label>
            arXiv queries <small>(one per line)</small>
            <textarea
              v-model="form.queries"
              rows="4"
              placeholder="all:dexterous AND all:manipulation&#10;all:grasping"
              :disabled="submitting"
            />
          </label>
          <label>
            Interests <small>(optional, comma-separated)</small>
            <textarea
              v-model="form.interests"
              rows="2"
              placeholder="dexterous hand, manipulation, grasping"
              :disabled="submitting"
            />
          </label>
          <div class="form-actions">
            <button type="submit" :disabled="submitting">
              {{ submitting ? 'Creating…' : 'Create & follow' }}
            </button>
            <button
              type="button"
              class="ghost sm"
              :disabled="submitting"
              @click="showForm = false"
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </template>
  </section>
</template>
