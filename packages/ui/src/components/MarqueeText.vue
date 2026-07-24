<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";

const props = defineProps<{ text: string }>();

const root = ref<HTMLElement | null>(null);
const overflowing = ref(false);
const overflowPx = ref(0);
let observer: ResizeObserver | null = null;

/** 总时长 = 两个方向的滚动时间（45px/s）+ 约 3 秒停顿 */
const duration = computed(() => `${(overflowPx.value * 2) / 45 + 3}s`);

function measure() {
  const el = root.value;
  if (!el) return;
  const distance = el.scrollWidth - el.clientWidth;
  overflowing.value = distance > 1;
  overflowPx.value = Math.max(0, distance);
}

onMounted(() => {
  measure();
  if (root.value) {
    observer = new ResizeObserver(measure);
    observer.observe(root.value);
  }
});
watch(() => props.text, () => requestAnimationFrame(measure));
onBeforeUnmount(() => observer?.disconnect());
</script>

<template>
  <strong ref="root" class="marquee-text" :class="{ 'is-overflowing': overflowing }" :title="text">
    <span
      class="marquee-text-inner"
      :style="{ '--marquee-distance': `-${overflowPx}px`, '--marquee-duration': duration }"
    >{{ text }}</span>
  </strong>
</template>
