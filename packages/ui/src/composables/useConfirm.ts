import { readonly, ref } from "vue";
import { useToast } from "./useToast";
import { describeTechnical } from "../utils/error";

export type ConfirmOptions = {
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
  run: () => Promise<void> | void;
};

type ConfirmState = ConfirmOptions & { loading: boolean };

const state = ref<ConfirmState | null>(null);

/** App-wide in-app confirm dialog. Mount <ConfirmDialog /> once in App.vue. */
export function useConfirm() {
  function ask(options: ConfirmOptions) {
    state.value = { ...options, loading: false };
  }
  function cancel() {
    if (state.value?.loading) return;
    state.value = null;
  }
  async function confirm() {
    if (!state.value || state.value.loading) return;
    const current = state.value;
    current.loading = true;
    try {
      await current.run();
      state.value = null;
    } catch (cause) {
      /* run() 正常应自行处理错误；这里兜底漏网异常，避免弹层滞留且用户毫无反馈 */
      console.error("[health-records] 确认操作执行失败", cause);
      useToast().show(`操作失败，请重试（${describeTechnical(cause)}）`, 3600);
    } finally {
      if (state.value === current) current.loading = false;
    }
  }
  return { state: readonly(state), ask, cancel, confirm };
}
