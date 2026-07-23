<script setup lang="ts">
import { FileHeart } from "@lucide/vue";

defineProps<{ title: string; description: string }>();
</script>

<template>
  <div class="empty-state">
    <span class="empty-icon"><FileHeart :size="28" /></span>
    <strong>{{ title }}</strong>
    <p>{{ description }}</p>
    <slot />
  </div>
</template>
