import { onActivated, onDeactivated, watch } from "vue";
import { useAppContext } from "./useAppContext";

/**
 * KeepAlive 缓存页面的静默刷新：
 * - 首次挂载不重复请求（页面 watch 已加载），之后每次切回先渲染缓存内容、再后台刷新数据；
 * - 页面处于激活状态时，其他页面广播的数据变更（上传完成、后台任务跑完）也会触发静默刷新。
 */
export function useRefreshOnActivate(refresh: () => void) {
  const app = useAppContext();
  let active = true;
  let wasDeactivated = false;
  /* 静默刷新失败不打扰用户，但要在控制台留痕，避免未捕获 rejection 且无据可查 */
  function runSafely() {
    try {
      void Promise.resolve(refresh()).catch((cause) => console.warn("[health-records] 后台刷新失败", cause));
    } catch (cause) {
      console.warn("[health-records] 后台刷新失败", cause);
    }
  }
  onDeactivated(() => {
    active = false;
    wasDeactivated = true;
  });
  onActivated(() => {
    active = true;
    if (!wasDeactivated) return;
    wasDeactivated = false;
    runSafely();
  });
  watch(app.dataVersion, () => {
    if (active) runSafely();
  });
}
