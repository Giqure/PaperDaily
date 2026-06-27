<script setup>
import { computed, ref, watch, nextTick, onMounted, onBeforeUnmount } from 'vue';

const props = defineProps({
  paper: { type: Object, required: true },
  // 'daily' shows the up/down vote icons; 'saved' shows Remove.
  context: { type: String, default: 'daily' },
});

const emit = defineEmits(['save', 'dismiss', 'unsave']);

// authors is a comma-joined string from the server; show only the first, with
// "et al." when there are more.
const authorList = computed(() => {
  if (!props.paper.authors) return '';
  const names = props.paper.authors.split(',').map((a) => a.trim()).filter(Boolean);
  if (!names.length) return '';
  return names.length > 1 ? `${names[0]} et al.` : names[0];
});

const saved = computed(() => props.paper.state === 'saved');
const dismissed = computed(() => props.paper.state === 'dismissed');

// Remove is a two-step confirm: the first click arms it, the second commits.
// It disarms on blur or after a short timeout so a stray click can't linger.
const confirmingRemove = ref(false);
let confirmTimer = null;

function onRemoveClick() {
  if (confirmingRemove.value) {
    clearTimeout(confirmTimer);
    confirmingRemove.value = false;
    emit('unsave');
    return;
  }
  confirmingRemove.value = true;
  confirmTimer = setTimeout(() => {
    confirmingRemove.value = false;
  }, 3000);
}

// AI vs original toggle only swaps the summary paragraph. It's offered when
// both an AI summary (zhSummary) and the original summary exist; the AI view is
// the default. The tldr highlight, when present, always shows.
const hasBothSummaries = computed(
  () => !!(props.paper.zhSummary && props.paper.summary)
);
const showAi = ref(true);

const summaryText = computed(() => {
  if (props.paper.zhSummary && (showAi.value || !props.paper.summary)) {
    return props.paper.zhSummary;
  }
  return props.paper.summary || '';
});

// Expand/collapse the summary. The button only appears when the text actually
// overflows the collapsed (line-clamped) height. We measure against the clamped
// box, so this is only checked while collapsed.
const summaryEl = ref(null);
const expanded = ref(false);
const overflowing = ref(false);

function measureOverflow() {
  const el = summaryEl.value;
  if (!el || expanded.value) return;
  overflowing.value = el.scrollHeight > el.clientHeight + 1;
}

// Re-measure after the text changes (AI/Original swap) and on mount. Collapse
// back to the clamped view when the summary content changes.
watch(summaryText, async () => {
  expanded.value = false;
  await nextTick();
  measureOverflow();
});

onMounted(async () => {
  await nextTick();
  measureOverflow();
});

onBeforeUnmount(() => clearTimeout(confirmTimer));
</script>

<template>
  <article class="paper" :class="{ dismissed }">
    <div v-if="paper.tag || hasBothSummaries" class="paper-meta">
      <span v-if="paper.tag" class="tag">{{ paper.tag }}</span>
      <button
        v-if="hasBothSummaries"
        class="ai-toggle"
        :class="{ on: showAi }"
        @click="showAi = !showAi"
      >
        {{ showAi ? 'AI' : 'Original' }}
      </button>
    </div>

    <h3 class="paper-title">
      <a v-if="paper.url" :href="paper.url" target="_blank" rel="noopener noreferrer">
        {{ paper.title }}
      </a>
      <span v-else>{{ paper.title }}</span>
    </h3>

    <p v-if="authorList" class="paper-authors">{{ authorList }}</p>

    <p v-if="paper.tldr" class="paper-tldr">{{ paper.tldr }}</p>
    <p
      v-if="summaryText"
      ref="summaryEl"
      class="paper-summary"
      :class="{ expanded }"
    >
      {{ summaryText }}
    </p>
    <button
      v-if="summaryText && (overflowing || expanded)"
      class="summary-toggle"
      @click="expanded = !expanded"
    >
      {{ expanded ? 'Show less ▴' : 'Show more ▾' }}
    </button>

    <div class="paper-actions">
      <template v-if="context === 'daily'">
        <button
          class="icon-btn"
          :class="{ active: saved }"
          title="Save"
          aria-label="Save"
          @click="emit('save')"
        >
          <!-- thumb up -->
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path
              fill="currentColor"
              d="M2 21h2.5a1 1 0 0 0 1-1v-9a1 1 0 0 0-1-1H2zm5.5-11.2 4.2-6.3a1.7 1.7 0 0 1 2.9 1.6l-1 4.4h5.1a2 2 0 0 1 2 2.5l-1.9 7A2 2 0 0 1 21 21H9.5a1 1 0 0 1-1-1V10.5a1 1 0 0 1 .2-.6z"
            />
          </svg>
        </button>
        <button
          class="icon-btn"
          :class="{ active: dismissed }"
          title="Dismiss"
          aria-label="Dismiss"
          @click="emit('dismiss')"
        >
          <!-- sad face -->
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
              <circle cx="12" cy="12" r="9.2" />
              <path d="M8.5 15.5c.9-1.1 2-1.7 3.5-1.7s2.6.6 3.5 1.7" />
              <path d="M9 9.5h.01M15 9.5h.01" />
            </g>
          </svg>
        </button>
      </template>
      <template v-else>
        <button
          class="ghost sm"
          :class="{ 'confirm-danger': confirmingRemove }"
          @click="onRemoveClick"
          @blur="confirmingRemove = false"
        >
          {{ confirmingRemove ? 'Confirm remove?' : 'Remove' }}
        </button>
      </template>
    </div>
  </article>
</template>
