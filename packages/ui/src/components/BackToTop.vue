<script setup lang="ts">
import { onActivated, onBeforeUnmount, onDeactivated, onMounted, ref } from "vue";
import { Rocket } from "@lucide/vue";

/*
 * 长列表页回顶部入口：仅当滚动高度超过 2 倍屏幕高度时出现。
 * 页面在 KeepAlive 中缓存，activated/deactivated 与 mount/unmount 成对维护监听，
 * addEventListener/removeEventListener 对同一引用幂等，重复调用安全。
 */
const visible = ref(false);

function onScroll() {
  visible.value = window.scrollY > window.innerHeight * 2;
}

function backToTop() {
  window.scrollTo({ top: 0, behavior: "smooth" });
}

onMounted(() => {
  onScroll();
  window.addEventListener("scroll", onScroll, { passive: true });
});
onActivated(() => {
  onScroll();
  window.addEventListener("scroll", onScroll, { passive: true });
});
onDeactivated(() => window.removeEventListener("scroll", onScroll));
onBeforeUnmount(() => window.removeEventListener("scroll", onScroll));
</script>

<template>
  <button
    v-if="visible"
    class="back-to-top"
    type="button"
    title="回到顶部"
    aria-label="回到顶部"
    @click="backToTop"
  >
    <Rocket :size="18" />
  </button>
</template>
