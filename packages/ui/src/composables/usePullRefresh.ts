import { onBeforeUnmount, onMounted, ref, type Ref } from "vue";

export const PULL_TRIGGER = 56;
const PULL_MAX = 92;

/** Touch pull-to-refresh bound to a page root element; only engages at window scroll top. */
export function usePullRefresh(root: Ref<HTMLElement | null>, onRefresh: () => Promise<void> | void) {
  const pullDistance = ref(0);
  const refreshing = ref(false);
  let touchStartY = 0;
  let pulling = false;

  async function refresh() {
    if (refreshing.value) return;
    refreshing.value = true;
    try { await onRefresh(); }
    catch (cause) {
      /* 调用方一般会自行提示；这里兜底，避免漏 catch 时变成未捕获 rejection 且毫无痕迹 */
      console.warn("[health-records] 下拉刷新执行失败", cause);
    }
    finally { refreshing.value = false; }
  }

  function onTouchStart(event: TouchEvent) {
    if (refreshing.value || window.scrollY > 0) return;
    touchStartY = event.touches[0].clientY;
    pulling = true;
  }
  function onTouchMove(event: TouchEvent) {
    if (!pulling || refreshing.value) return;
    const delta = event.touches[0].clientY - touchStartY;
    if (delta <= 0 || window.scrollY > 0) {
      pullDistance.value = 0;
      return;
    }
    event.preventDefault();
    pullDistance.value = Math.min(delta * 0.45, PULL_MAX);
  }
  function onTouchEnd() {
    if (!pulling) return;
    pulling = false;
    if (pullDistance.value >= PULL_TRIGGER) void refresh();
    pullDistance.value = 0;
  }

  onMounted(() => {
    const el = root.value;
    if (!el) return;
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd, { passive: true });
  });
  onBeforeUnmount(() => {
    const el = root.value;
    if (!el) return;
    el.removeEventListener("touchstart", onTouchStart);
    el.removeEventListener("touchmove", onTouchMove);
    el.removeEventListener("touchend", onTouchEnd);
  });

  return { pullDistance, refreshing, refresh };
}
