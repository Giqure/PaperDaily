<script setup>
import { ref, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { settingsApi } from '../api.js';

// Local editable copy of the user's push settings, loaded from the server.
const settings = ref({ emailPushEnabled: false, barkPushEnabled: false, barkKey: '', email: '' });
const loading = ref(true);
const saving = ref(false);
const error = ref('');
const saved = ref(false);

// Email push has its own confirm-by-link flow, so it gets its own busy flag and
// notice line separate from the Bark form's save state.
const emailBusy = ref(false);
const emailNotice = ref('');

// Collapsed by default — the rail stays clean until the user opens it.
const open = ref(false);

const route = useRoute();
const router = useRouter();

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

// Bark settings only — email push is changed through its own buttons below.
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

// "Turn on": ask the server to mail a confirmation link. Email push only flips
// on once the user clicks that link (handled by the confirm redirect below).
async function turnOnEmail() {
  error.value = '';
  emailNotice.value = '';
  emailBusy.value = true;
  try {
    const res = await settingsApi.requestEmailPush();
    if (res.status === 'already-on') {
      await load();
    } else {
      emailNotice.value =
        `Confirmation link sent to ${settings.value.email}. Open it to finish turning on email push.`;
    }
  } catch (err) {
    error.value = err.message;
  } finally {
    emailBusy.value = false;
  }
}

// "Turn off" is a double-click button — no extra confirm step (stopping mail is
// low-risk, so the double-click alone guards against an accidental single tap).
async function turnOffEmail() {
  error.value = '';
  emailNotice.value = '';
  emailBusy.value = true;
  try {
    const res = await settingsApi.disableEmailPush();
    settings.value = { ...settings.value, ...res.settings };
  } catch (err) {
    error.value = err.message;
  } finally {
    emailBusy.value = false;
  }
}

onMounted(async () => {
  await load();

  // The mailed confirmation link redirects back here with ?emailPush=… —
  // surface the outcome and drop the param so a refresh doesn't repeat it.
  const outcome = route.query.emailPush;
  if (outcome) {
    open.value = true;
    if (outcome === 'confirmed') {
      emailNotice.value = 'Email push is on.';
    } else if (outcome === 'invalid') {
      error.value = 'That confirmation link is invalid or has expired. Try turning email push on again.';
    }
    const query = { ...route.query };
    delete query.emailPush;
    router.replace({ query });
  }
});
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

      <!-- Email push: confirm-by-link to turn on, double-click to turn off. -->
      <div class="channel">
        <div class="channel-head">
          <span class="channel-label">
            Email
            <small class="muted">to {{ settings.email }}</small>
          </span>
        </div>
        <button
          v-if="!settings.emailPushEnabled"
          type="button"
          class="ghost sm"
          :disabled="emailBusy"
          @click="turnOnEmail"
        >
          {{ emailBusy ? 'Working…' : 'Turn on' }}
        </button>
        <button
          v-else
          type="button"
          class="ghost sm danger"
          title="Double-click to turn off"
          :disabled="emailBusy"
          @dblclick="turnOffEmail"
        >
          {{ emailBusy ? 'Working…' : 'Turn off (double-click)' }}
        </button>
        <p v-if="settings.emailPushEnabled" class="muted channel-state">On.</p>
        <p v-if="emailNotice" class="ok channel-state">{{ emailNotice }}</p>
      </div>

      <!-- Bark push: a device key the user saves directly. The Save button
           commits Bark settings only — email has its own buttons above. -->
      <form class="channel" @submit.prevent="save">
        <div class="channel-head">
          <span class="channel-label">
            Bark
            <small class="muted">iOS push</small>
          </span>
          <label class="toggle-row">
            <input v-model="settings.barkPushEnabled" type="checkbox" :disabled="saving" />
            <span>Enable</span>
          </label>
        </div>

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

        <div class="channel-foot">
          <button type="submit" class="sm" :disabled="saving">
            {{ saving ? 'Saving…' : 'Save Bark' }}
          </button>
          <span v-if="saved" class="ok channel-state">Saved.</span>
        </div>
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
  margin-bottom: 1.25rem;
  line-height: 1.55;
}
/* Email and Bark are parallel channels — same head + body shape so they read
   as a matched pair. */
.channel {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}
.channel + .channel {
  padding-top: 1.25rem;
  margin-top: 1.25rem;
  border-top: 1px solid var(--rule, #e3e0d8);
}
.channel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}
.channel-label {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  font-size: 0.9rem;
  font-weight: 600;
  color: var(--ink-soft, #4a4844);
}
.channel-label small {
  font-weight: 400;
  padding: 0;
  word-break: break-all;
}
/* Channel action buttons size to content and sit at the start, not stretched. */
.channel > button {
  align-self: flex-start;
}
.channel-state {
  margin: 0;
  padding: 0;
}
.ghost.sm.danger {
  color: var(--danger, #c62828);
}
.toggle-row {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  cursor: pointer;
  font-size: 0.85rem;
  font-weight: 500;
  color: var(--ink-soft, #4a4844);
}
.toggle-row input {
  width: auto;
}
.bark-key {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}
.channel-foot {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}
.channel-foot button {
  align-self: flex-start;
}
.ok {
  color: var(--ok, #2e7d32);
  margin: 0;
  padding: 0;
}
</style>
