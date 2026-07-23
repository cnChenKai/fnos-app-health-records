import { readonly, ref } from "vue";

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
    } finally {
      if (state.value === current) current.loading = false;
    }
  }
  return { state: readonly(state), ask, cancel, confirm };
}
