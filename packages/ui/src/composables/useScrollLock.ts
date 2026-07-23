import { onBeforeUnmount, watch, type Ref } from "vue";

let lockCount = 0;
function apply() {
  document.body.style.overflow = lockCount > 0 ? "hidden" : "";
}

/** Locks body scroll while `locked` is true. Ref-counted, safe for nested overlays; always restores on unmount. */
export function useScrollLock(locked: Ref<boolean>) {
  let held = false;
  watch(locked, (value) => {
    if (value && !held) {
      held = true;
      lockCount += 1;
      apply();
    } else if (!value && held) {
      held = false;
      lockCount = Math.max(0, lockCount - 1);
      apply();
    }
  }, { immediate: true });
  onBeforeUnmount(() => {
    if (held) {
      held = false;
      lockCount = Math.max(0, lockCount - 1);
      apply();
    }
  });
}
