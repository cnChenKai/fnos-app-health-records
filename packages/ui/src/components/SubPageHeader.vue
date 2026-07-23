<script setup lang="ts">
import { ChevronLeft } from "@lucide/vue";
import { useRouter } from "vue-router";

const props = withDefaults(defineProps<{ title: string; description?: string; backTo?: string; backLabel?: string }>(), {
  backTo: "/me",
  backLabel: "返回我的"
});
const router = useRouter();
</script>

<template>
  <header class="subpage-header">
    <button class="subpage-back" type="button" :aria-label="props.backLabel" @click="router.push(props.backTo)"><ChevronLeft :size="20" /></button>
    <div><h2>{{ title }}</h2><p v-if="description">{{ description }}</p></div>
    <slot />
  </header>
</template>
