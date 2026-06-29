<script setup>
import { ref, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { settingsApi } from '../api.js';

const { t } = useI18n();

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
    error.value = t('push.errBarkKey');
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
      emailNotice.value = t('push.confirmSent', { email: settings.value.email });
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
      emailNotice.value = t('push.confirmed');
    } else if (outcome === 'invalid') {
      error.value = t('push.invalidLink');
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
      <h2>{{ t('push.title') }}</h2>
      <button class="link-btn" @click="open = !open">
        {{ open ? t('push.done') : t('push.edit') }}
      </button>
    </header>

    <div v-if="loading" class="muted">{{ t('push.loading') }}</div>

    <template v-else-if="open">
      <p class="muted push-intro">
        {{ t('push.intro') }}
      </p>

      <p v-if="error" class="error">{{ error }}</p>

      <!-- Email push: confirm-by-link to turn on, double-click to turn off. -->
      <div class="channel">
        <div class="channel-head">
          <span class="channel-label">
            {{ t('push.email') }}
            <small class="muted">{{ t('push.emailTo', { email: settings.email }) }}</small>
          </span>
        </div>
        <button
          v-if="!settings.emailPushEnabled"
          type="button"
          class="ghost sm"
          :disabled="emailBusy"
          @click="turnOnEmail"
        >
          {{ emailBusy ? t('push.working') : t('push.turnOn') }}
        </button>
        <button
          v-else
          type="button"
          class="ghost sm danger"
          :title="t('push.turnOffTitle')"
          :disabled="emailBusy"
          @dblclick="turnOffEmail"
        >
          {{ emailBusy ? t('push.working') : t('push.turnOffDouble') }}
        </button>
        <p v-if="settings.emailPushEnabled" class="muted channel-state">{{ t('push.on') }}</p>
        <p v-if="emailNotice" class="ok channel-state">{{ emailNotice }}</p>
      </div>

      <!-- Bark push: a device key the user saves directly. The Save button
           commits Bark settings only — email has its own buttons above. -->
      <form class="channel" @submit.prevent="save">
        <div class="channel-head">
          <span class="channel-label">
            {{ t('push.bark') }}
            <small class="muted">{{ t('push.barkSub') }}</small>
          </span>
          <label class="toggle-row">
            <input v-model="settings.barkPushEnabled" type="checkbox" :disabled="saving" />
            <span>{{ t('push.enable') }}</span>
          </label>
        </div>

        <label v-if="settings.barkPushEnabled" class="bark-key">
          {{ t('push.barkKey') }}
          <input
            v-model="settings.barkKey"
            type="text"
            maxlength="120"
            :placeholder="t('push.barkKeyPlaceholder')"
            :disabled="saving"
          />
          <small class="muted">
            {{ t('push.barkKeyHint') }}
          </small>
        </label>

        <div class="channel-foot">
          <button type="submit" class="sm" :disabled="saving">
            {{ saving ? t('push.saving') : t('push.saveBark') }}
          </button>
          <span v-if="saved" class="ok channel-state">{{ t('push.saved') }}</span>
        </div>
      </form>
    </template>

    <!-- Collapsed summary -->
    <p v-else class="muted">
      <template v-if="settings.emailPushEnabled || settings.barkPushEnabled">
        {{ t('push.onLabel') }}
        <template v-if="settings.emailPushEnabled">{{ t('push.email') }}</template>
        <template v-if="settings.emailPushEnabled && settings.barkPushEnabled"> + </template>
        <template v-if="settings.barkPushEnabled">{{ t('push.bark') }}</template>
      </template>
      <template v-else>{{ t('push.pushOff') }}</template>
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
