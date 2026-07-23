import { readonly, ref } from "vue";

const message = ref("");
const visible = ref(false);
let timer: ReturnType<typeof setTimeout> | null = null;

/** Global lightweight toast; the toast element is mounted once in App.vue. */
export function useToast() {
  function show(text: string, duration = 1800) {
    message.value = text;
    visible.value = true;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { visible.value = false; }, duration);
  }
  return { message: readonly(message), visible: readonly(visible), show };
}
