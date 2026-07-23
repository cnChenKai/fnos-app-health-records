<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  ChevronLeft, ChevronRight, Download, LoaderCircle, Maximize2,
  RectangleHorizontal, RectangleVertical, X, ZoomIn, ZoomOut
} from "@lucide/vue";
import { useScrollLock } from "../composables/useScrollLock";

export type ImageViewerPage = {
  key: string;
  fullUrl: string;
  previewUrl?: string;
  label: string;
  downloadUrl?: string;
  downloadName?: string;
};

const props = defineProps<{
  pages: ImageViewerPage[];
  startIndex?: number;
}>();
const emit = defineEmits<{ close: [] }>();

const viewerIndex = ref(0);
const viewerScale = ref(1);
const viewerRotation = ref(0);
const viewerImmersive = ref(false);
const viewerHighRes = ref(false);
const viewerLoading = ref(false);
const viewerHighResLoading = ref(false);
const viewerPanX = ref(0);
const viewerPanY = ref(0);
const viewerGesturing = ref(false);
const viewerNaturalW = ref(0);
const viewerNaturalH = ref(0);
const viewerCanvasEl = ref<HTMLElement | null>(null);
const viewerCanvasW = ref(0);
const viewerCanvasH = ref(0);

const viewerPage = computed(() => props.pages[viewerIndex.value] || null);
const viewerUsingPreview = computed(() => Boolean(viewerPage.value?.previewUrl) && !viewerHighRes.value);
const viewerDisplaySrc = computed(() => {
  const page = viewerPage.value;
  if (!page) return "";
  return viewerUsingPreview.value && page.previewUrl ? page.previewUrl : page.fullUrl;
});
const viewerDownloadSrc = computed(() => viewerPage.value?.downloadUrl || viewerPage.value?.fullUrl || "");

function resetViewerTransform() {
  viewerScale.value = 1;
  viewerRotation.value = 0;
  viewerPanX.value = 0;
  viewerPanY.value = 0;
}

function resetViewerCanvasScroll() {
  const el = viewerCanvasEl.value;
  if (el) {
    el.scrollLeft = 0;
    el.scrollTop = 0;
  }
}

let viewerPreloadSeq = 0;
function prepareViewerPage(index: number) {
  viewerIndex.value = index;
  resetViewerTransform();
  resetViewerCanvasScroll();
  viewerHighRes.value = false;
  viewerNaturalW.value = 0;
  viewerNaturalH.value = 0;
  const page = viewerPage.value;
  const seq = ++viewerPreloadSeq;
  if (!page || !page.previewUrl) {
    viewerHighRes.value = true;
    viewerLoading.value = Boolean(page);
    viewerHighResLoading.value = false;
    return;
  }
  viewerLoading.value = false;
  viewerHighResLoading.value = true;
  const probe = new Image();
  probe.onload = () => {
    if (seq !== viewerPreloadSeq) return;
    viewerHighResLoading.value = false;
    viewerHighRes.value = true;
  };
  probe.onerror = () => {
    if (seq === viewerPreloadSeq) viewerHighResLoading.value = false;
  };
  probe.src = page.fullUrl;
}

function moveViewer(direction: -1 | 1) {
  if (!props.pages.length) return;
  prepareViewerPage((viewerIndex.value + direction + props.pages.length) % props.pages.length);
}

function setViewerScale(next: number) {
  viewerScale.value = Math.min(3, Math.max(0.5, Number(next.toFixed(2))));
  if (viewerScale.value === 1) {
    viewerPanX.value = 0;
    viewerPanY.value = 0;
    resetViewerCanvasScroll();
  }
}

function zoomViewer(direction: -1 | 1) {
  setViewerScale(viewerScale.value + direction * 0.25);
}

function toggleViewerOrientation() {
  viewerRotation.value = viewerRotation.value % 180 === 0 ? 90 : 0;
  setViewerScale(1);
  resetViewerCanvasScroll();
}

function enterViewerImmersive() {
  viewerImmersive.value = true;
}

/* 触屏手势：单指拖动/翻页、双指捏合缩放、点黑色区域退出全屏 */
const viewerGesture = {
  mode: "none" as "none" | "pan" | "pinch" | "swipe",
  startX: 0, startY: 0, startPanX: 0, startPanY: 0,
  startDist: 0, startScale: 1, moved: false
};

function touchDistance(a: Touch, b: Touch) {
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}

function onViewerTouchStart(event: TouchEvent) {
  if (event.touches.length === 2) {
    viewerGesture.mode = "pinch";
    viewerGesture.startDist = touchDistance(event.touches[0], event.touches[1]);
    viewerGesture.startScale = viewerScale.value;
    viewerGesturing.value = true;
    return;
  }
  if (event.touches.length !== 1) return;
  const touch = event.touches[0];
  viewerGesture.mode = viewerScale.value > 1 ? "pan" : "swipe";
  viewerGesture.startX = touch.clientX;
  viewerGesture.startY = touch.clientY;
  viewerGesture.startPanX = viewerPanX.value;
  viewerGesture.startPanY = viewerPanY.value;
  viewerGesture.moved = false;
  viewerGesturing.value = true;
}

function onViewerTouchMove(event: TouchEvent) {
  if (viewerGesture.mode === "pinch" && event.touches.length === 2) {
    const ratio = touchDistance(event.touches[0], event.touches[1]) / (viewerGesture.startDist || 1);
    setViewerScale(viewerGesture.startScale * ratio);
    viewerGesture.moved = true;
    return;
  }
  if (event.touches.length !== 1) return;
  const touch = event.touches[0];
  if (Math.abs(touch.clientX - viewerGesture.startX) > 10 || Math.abs(touch.clientY - viewerGesture.startY) > 10) {
    viewerGesture.moved = true;
  }
  if (viewerGesture.mode !== "pan") return;
  viewerPanX.value = viewerGesture.startPanX + touch.clientX - viewerGesture.startX;
  viewerPanY.value = viewerGesture.startPanY + touch.clientY - viewerGesture.startY;
}

function isViewerBackground(target: EventTarget | null) {
  return target instanceof HTMLElement && target.classList.contains("original-viewer-canvas");
}

function onViewerTouchEnd(event: TouchEvent) {
  if (event.touches.length > 0) return;
  const mode = viewerGesture.mode;
  viewerGesture.mode = "none";
  viewerGesturing.value = false;
  if (mode !== "swipe" && mode !== "pan") return;
  if (!viewerGesture.moved) {
    if (viewerImmersive.value && isViewerBackground(event.target)) viewerImmersive.value = false;
    return;
  }
  if (mode === "swipe" && props.pages.length > 1) {
    const dx = event.changedTouches[0].clientX - viewerGesture.startX;
    const dy = event.changedTouches[0].clientY - viewerGesture.startY;
    if (Math.abs(dx) >= 56 && Math.abs(dx) > Math.abs(dy) * 1.5) moveViewer(dx < 0 ? 1 : -1);
  }
}

function onViewerCanvasClick(event: MouseEvent) {
  if (viewerImmersive.value && isViewerBackground(event.target)) viewerImmersive.value = false;
}

/* 按图片真实宽高比计算铺满尺寸：竖图按宽度铺满，横图按高度铺满，旋转后同样适配 */
const viewerFitStyle = computed(() => {
  const nw = viewerNaturalW.value;
  const nh = viewerNaturalH.value;
  const cw = viewerCanvasW.value;
  const ch = viewerCanvasH.value;
  if (!nw || !nh || !cw || !ch) return {};
  const rotated = viewerRotation.value % 180 !== 0;
  const effW = rotated ? nh : nw;
  const effH = rotated ? nw : nh;
  const fit = Math.min(cw / effW, ch / effH);
  return {
    width: `${Math.max(1, Math.round(nw * fit))}px`,
    height: `${Math.max(1, Math.round(nh * fit))}px`,
    maxWidth: "none",
    maxHeight: "none"
  };
});

function onViewerImageLoad(event: Event) {
  viewerLoading.value = false;
  const img = event.target as HTMLImageElement;
  viewerNaturalW.value = img.naturalWidth || 0;
  viewerNaturalH.value = img.naturalHeight || 0;
}

let viewerCanvasObserver: ResizeObserver | null = null;

function handleViewerKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") {
    if (viewerImmersive.value) viewerImmersive.value = false;
    else emit("close");
  }
  else if (event.key === "ArrowLeft") moveViewer(-1);
  else if (event.key === "ArrowRight") moveViewer(1);
  else if (event.key === "+" || event.key === "=") zoomViewer(1);
  else if (event.key === "-") zoomViewer(-1);
  else return;
  event.preventDefault();
}

useScrollLock(computed(() => true));

onMounted(async () => {
  prepareViewerPage(Math.min(Math.max(props.startIndex || 0, 0), Math.max(props.pages.length - 1, 0)));
  window.addEventListener("keydown", handleViewerKeydown);
  await nextTick();
  const el = viewerCanvasEl.value;
  if (el) {
    const measure = () => {
      viewerCanvasW.value = el.clientWidth;
      viewerCanvasH.value = el.clientHeight;
    };
    measure();
    viewerCanvasObserver = new ResizeObserver(measure);
    viewerCanvasObserver.observe(el);
  }
});
onBeforeUnmount(() => {
  viewerCanvasObserver?.disconnect();
  window.removeEventListener("keydown", handleViewerKeydown);
});
</script>

<template>
  <div class="original-viewer" :class="{ immersive: viewerImmersive }" role="dialog" aria-modal="true" @click.self="emit('close')">
    <header class="original-viewer-header">
      <div>
        <strong>{{ viewerPage?.label || "查看图片" }}</strong>
        <span v-if="pages.length > 1">第 {{ viewerIndex + 1 }} 页 / 共 {{ pages.length }} 页</span>
      </div>
      <div class="original-viewer-actions">
        <slot name="actions" />
        <button type="button" title="缩小" :disabled="viewerScale <= 0.5" @click="zoomViewer(-1)"><ZoomOut :size="18" /></button>
        <span>{{ Math.round(viewerScale * 100) }}%</span>
        <button type="button" title="放大" :disabled="viewerScale >= 3" @click="zoomViewer(1)"><ZoomIn :size="18" /></button>
        <button
          type="button"
          :title="viewerRotation % 180 === 0 ? '切换为横屏' : '切换为竖屏'"
          @click="toggleViewerOrientation"
        >
          <RectangleHorizontal v-if="viewerRotation % 180 === 0" :size="18" />
          <RectangleVertical v-else :size="18" />
        </button>
        <a :href="viewerDownloadSrc" :download="viewerPage?.downloadName || viewerPage?.label" title="下载"><Download :size="18" /></a>
      </div>
      <button class="viewer-close-button" type="button" title="关闭" @click="emit('close')"><X :size="20" /></button>
    </header>
    <main class="original-viewer-stage">
      <button v-if="pages.length > 1" class="viewer-nav-button viewer-nav-button--prev" type="button" title="上一页" @click="moveViewer(-1)">
        <ChevronLeft :size="24" />
      </button>
      <div
        ref="viewerCanvasEl"
        class="original-viewer-canvas"
        :class="{ 'is-preview': viewerUsingPreview, gesturing: viewerGesturing, fit: viewerScale === 1 }"
        @touchstart="onViewerTouchStart"
        @touchmove.prevent="onViewerTouchMove"
        @touchend="onViewerTouchEnd"
        @touchcancel="onViewerTouchEnd"
        @click="onViewerCanvasClick"
      >
        <div v-if="viewerLoading" class="viewer-loading"><LoaderCircle class="spin-icon" :size="18" />加载中</div>
        <div v-if="viewerHighResLoading" class="viewer-preview-badge"><LoaderCircle class="spin-icon" :size="13" />正在加载高清图…</div>
        <img
          v-if="viewerPage"
          :src="viewerDisplaySrc"
          :alt="viewerPage.label"
          :style="[viewerFitStyle, { transform: `translate(-50%, -50%) translate3d(${viewerPanX}px, ${viewerPanY}px, 0) scale(${viewerScale}) rotate(${viewerRotation}deg)` }]"
          @load="onViewerImageLoad"
        />
        <button
          v-if="!viewerImmersive"
          class="viewer-fullscreen-button"
          type="button"
          title="全屏查看"
          @click.stop="enterViewerImmersive"
        >
          <Maximize2 :size="19" />
        </button>
        <button
          v-if="viewerImmersive"
          class="viewer-fullscreen-button viewer-orient-button"
          type="button"
          :title="viewerRotation % 180 === 0 ? '切换为横屏' : '切换为竖屏'"
          @click.stop="toggleViewerOrientation"
        >
          <RectangleHorizontal v-if="viewerRotation % 180 === 0" :size="19" />
          <RectangleVertical v-else :size="19" />
        </button>
      </div>
      <button v-if="pages.length > 1" class="viewer-nav-button viewer-nav-button--next" type="button" title="下一页" @click="moveViewer(1)">
        <ChevronRight :size="24" />
      </button>
    </main>
    <footer class="original-viewer-footer">
      <span class="viewer-hint-desktop">快捷键：←/→ 翻页，+/- 缩放，Esc 关闭</span>
      <span class="viewer-hint-touch">双指缩放 · 拖动查看 · 滑翻页 · 点黑边退出全屏</span>
    </footer>
  </div>
</template>
