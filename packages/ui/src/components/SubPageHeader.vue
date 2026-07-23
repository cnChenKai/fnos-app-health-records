<script setup lang="ts">
import { ChevronLeft } from "@lucide/vue";
import { useRouter } from "vue-router";

defineProps<{ title: string; description?: string }>();
const router = useRouter();
</script>

<template>
  <header class="subpage-header">
    <button class="subpage-back" type="button" aria-label="返回我的" @click="router.push('/me')"><ChevronLeft :size="20" /></button>
    <div><h2>{{ title }}</h2><p v-if="description">{{ description }}</p></div>
    <slot />
  </header>
</template>
