<script setup>
import { ref, onMounted } from 'vue';
import { settingsApi } from '../api.js';

// Local editable copy of the user's push settings, loaded from the server.
const settings = ref({ emailPushEnabled: false, barkPushEnabled: false, barkKey: '', email: '' });
const loading = ref(true);
const saving = ref(false);
const error = ref('');
const saved = ref(false);

// Collapsed by default — the rail stays clean until the user opens it.
const open = ref(false);

async function load() {
  loading.value = true;
  try {
    const res = await settingsApi.getPush();
    settings.value = { ...settings.value, ...res.settings };
  } catch (err) {
    error.value = err.message;
  } finally {
    loading.value = false;
  }
}

async function save() {
  error.value = '';
  saved.value = false;

  const barkKey = settings.value.barkKey.trim();
  if (settings.value.barkPushEnabled && !barkKey) {
    error.value = 'Enter your Bark key to enable Bark push.';
    return;
  }

  saving.value = true;
  try {
    const res = await settingsApi.updatePush({
      emailPushEnabled: settings.value.emailPushEnabled,
      barkPushEnabled: settings.value.barkPushEnabled,
      barkKey,
    });
    settings.value = { ...settings.value, ...res.settings };
    saved.value = true;
  } catch (err) {
    error.value = err.message;
  } finally {
    saving.value = false;
  }
}

onMounted(load);
</script>

<template>
  <section class="panel">
    <header class="panel-head">
      <h2>Daily push</h2>
      <button class="link-btn" @click="open = !open">
        {{ open ? 'Done' : 'Edit' }}
      </button>
    </header>

    <div v-if="loading" class="muted">Loading…</div>

    <template v-else-if="open">
      <p class="muted push-intro">
        Get your subscribed scopes' daily digest pushed to you.
      </p>

      <p v-if="error" class="error">{{ error }}</p>
      <p v-if="saved" class="ok">Saved.</p>

      <form class="push-form" @submit.prevent="save">
        <label class="toggle-row">
          <input v-model="settings.emailPushEnabled" type="checkbox" :disabled="saving" />
          <span>
            Email
            <small class="muted">to {{ settings.email }}</small>
          </span>
        </label>

        <label class="toggle-row">
          <input v-model="settings.barkPushEnabled" type="checkbox" :disabled="saving" />
          <span>Bark (iOS push)</span>
        </label>

        <label v-if="settings.barkPushEnabled" class="bark-key">
          Bark key
          <input
            v-model="settings.barkKey"
            type="text"
            maxlength="120"
            placeholder="your device key"
            :disabled="saving"
          />
          <small class="muted">
            From the Bark app — the token after the server URL.
          </small>
        </label>

        <button type="submit" :disabled="saving">
          {{ saving ? 'Saving…' : 'Save' }}
        </button>
      </form>
    </template>

    <!-- Collapsed summary -->
    <p v-else class="muted">
      <template v-if="settings.emailPushEnabled || settings.barkPushEnabled">
        On:
        <template v-if="settings.emailPushEnabled">email</template>
        <template v-if="settings.emailPushEnabled && settings.barkPushEnabled"> + </template>
        <template v-if="settings.barkPushEnabled">Bark</template>
      </template>
      <template v-else>Push is off.</template>
    </p>
  </section>
</template>

<style scoped>
.push-intro {
  margin-top: 0;
}
.push-form {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.toggle-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  cursor: pointer;
}
.toggle-row input {
  width: auto;
}
.bark-key {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.ok {
  color: var(--ok, #2e7d32);
  margin: 0;
}
</style>
