<script setup>
import { computed } from 'vue';

const props = defineProps({
  paper: { type: Object, required: true },
  // 'daily' shows Save + Dismiss; 'saved' shows Unsave.
  context: { type: String, default: 'daily' },
});

const emit = defineEmits(['save', 'dismiss', 'unsave']);

// authors is a comma-joined string from the server; show the first few.
const authorList = computed(() => {
  if (!props.paper.authors) return '';
  const names = props.paper.authors.split(',').map((a) => a.trim());
  return names.length > 4
    ? `${names.slice(0, 4).join(', ')} +${names.length - 4}`
    : names.join(', ');
});

const saved = computed(() => props.paper.state === 'saved');
</script>

<template>
  <article class="paper">
    <div v-if="paper.tag || paper.scopes?.length" class="paper-meta">
      <span v-if="paper.tag" class="tag">{{ paper.tag }}</span>
      <span v-for="name in paper.scopes" :key="name" class="scope-pill">
        {{ name }}
      </span>
    </div>

    <h3 class="paper-title">
      <a v-if="paper.url" :href="paper.url" target="_blank" rel="noopener noreferrer">
        {{ paper.title }}
      </a>
      <span v-else>{{ paper.title }}</span>
    </h3>

    <p v-if="paper.tldr" class="paper-tldr">{{ paper.tldr }}</p>
    <p v-if="authorList" class="paper-authors">{{ authorList }}</p>
    <p v-if="paper.zhSummary" class="paper-abstract">{{ paper.zhSummary }}</p>
    <p v-else-if="paper.abstract" class="paper-abstract">{{ paper.abstract }}</p>

    <div class="paper-actions">
      <template v-if="context === 'daily'">
        <button class="ghost sm" :class="{ active: saved }" @click="emit('save')">
          {{ saved ? '★ Saved' : '☆ Save' }}
        </button>
        <button class="ghost sm" @click="emit('dismiss')">Dismiss</button>
      </template>
      <template v-else>
        <button class="ghost sm" @click="emit('unsave')">Remove</button>
      </template>
    </div>
  </article>
</template>
