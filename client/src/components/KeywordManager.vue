<script setup>
import { ref, computed, onMounted } from 'vue';
import { subscriptionsApi } from '../api.js';

const emit = defineEmits(['changed']);

const subscriptions = ref([]);
const library = ref([]);
const authored = ref({ used: 0, max: 3 });
const newKeyword = ref('');
const loading = ref(true);
const submitting = ref(false);
const error = ref('');

// Keywords already followed, to dim them in the library picker.
const followed = computed(
  () => new Set(subscriptions.value.map((s) => s.keyword))
);

// Library keywords the user hasn't followed yet.
const available = computed(() =>
  library.value.filter((k) => !followed.value.has(k.keyword))
);

async function load() {
  loading.value = true;
  try {
    const [subs, lib] = await Promise.all([
      subscriptionsApi.list(),
      subscriptionsApi.library(),
    ]);
    subscriptions.value = subs.subscriptions;
    authored.value = subs.authored;
    library.value = lib.library;
  } catch (err) {
    error.value = err.message;
  } finally {
    loading.value = false;
  }
}

async function add(keyword) {
  const kw = (keyword ?? newKeyword.value).trim();
  if (!kw) return;
  error.value = '';
  submitting.value = true;
  try {
    await subscriptionsApi.add(kw);
    newKeyword.value = '';
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
      <h2>Keywords</h2>
      <span class="budget" :class="{ full: authored.used >= authored.max }">
        {{ authored.used }}/{{ authored.max }} custom
      </span>
    </header>

    <p class="hint">
      Follow topics to shape your daily digest. Pick from the library, or add a
      new keyword — new keywords join the shared library for everyone, and you
      can introduce up to {{ authored.max }}.
    </p>

    <form class="add-row" @submit.prevent="add()">
      <input
        v-model="newKeyword"
        type="text"
        maxlength="80"
        placeholder="Add a keyword…"
        :disabled="submitting"
      />
      <button type="submit" :disabled="submitting || !newKeyword.trim()">
        {{ submitting ? 'Adding…' : 'Add' }}
      </button>
    </form>

    <p v-if="error" class="error">{{ error }}</p>

    <div v-if="loading" class="muted">Loading…</div>

    <template v-else>
      <!-- Followed keywords -->
      <div v-if="subscriptions.length" class="chips">
        <span
          v-for="sub in subscriptions"
          :key="sub.id"
          class="chip"
          :class="{ custom: sub.isCustom }"
        >
          {{ sub.keyword }}
          <button
            class="chip-x"
            title="Unfollow"
            @click="remove(sub)"
            aria-label="Unfollow keyword"
          >
            ×
          </button>
        </span>
      </div>
      <p v-else class="muted">You're not following any keywords yet.</p>

      <!-- Library picker -->
      <div v-if="available.length" class="library">
        <h3>From the library</h3>
        <div class="chips">
          <button
            v-for="k in available"
            :key="k.id"
            class="chip add"
            :disabled="submitting"
            @click="add(k.keyword)"
          >
            + {{ k.keyword }}
          </button>
        </div>
      </div>
    </template>
  </section>
</template>
