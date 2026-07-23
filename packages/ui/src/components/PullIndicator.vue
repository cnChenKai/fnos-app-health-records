<script setup lang="ts">
import { ArrowDown, LoaderCircle } from "@lucide/vue";
import { PULL_TRIGGER } from "../composables/usePullRefresh";

defineProps<{ distance: number; refreshing: boolean }>();
</script>

<template>
  <div class="pull-refresh" :style="{ height: refreshing ? '44px' : `${distance}px` }">
    <template v-if="refreshing">
      <LoaderCircle :size="18" class="spin-icon" />
      <span class="pull-refresh-text">正在刷新…</span>
    </template>
    <template v-else>
      <ArrowDown :size="17" class="pull-refresh-arrow" :style="{ transform: `rotate(${distance >= PULL_TRIGGER ? 180 : 0}deg)` }" />
      <span class="pull-refresh-text">{{ distance >= PULL_TRIGGER ? "释放即可刷新" : "下拉即可刷新" }}</span>
    </template>
  </div>
</template>
