<script setup>
import { ref, onMounted } from 'vue';

const title = ref('PaperDaily');
const message = ref('Your daily digest of research papers.');

onMounted(async () => {
  try {
    const res = await fetch('/api/welcome');
    if (res.ok) {
      const data = await res.json();
      title.value = data.title;
      message.value = data.message;
    }
  } catch (err) {
    // API unavailable — keep defaults
  }
});
</script>

<template>
  <main class="welcome">
    <h1>{{ title }}</h1>
    <p>{{ message }}</p>
  </main>
</template>
