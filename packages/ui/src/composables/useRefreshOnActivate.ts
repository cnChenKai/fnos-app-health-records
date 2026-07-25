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
  onDeactivated(() => {
    active = false;
    wasDeactivated = true;
  });
  onActivated(() => {
    active = true;
    if (!wasDeactivated) return;
    wasDeactivated = false;
    refresh();
  });
  watch(app.dataVersion, () => {
    if (active) refresh();
  });
}
