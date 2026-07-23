<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { Check, ChevronDown } from "@lucide/vue";
import { useScrollLock } from "../composables/useScrollLock";

type Option = { value: string; label: string; disabled?: boolean };

const props = defineProps<{
  modelValue: string;
  options: Option[];
  placeholder?: string;
  disabled?: boolean;
  ariaLabel?: string;
}>();
const emit = defineEmits<{ "update:modelValue": [value: string]; change: [value: string] }>();

const open = ref(false);
const root = ref<HTMLElement | null>(null);
const layer = ref<HTMLElement | null>(null);
const panelStyle = ref<Record<string, string>>({});
const lockScroll = ref(false);
useScrollLock(computed(() => open.value && lockScroll.value));

const current = computed(() => props.options.find((option) => option.value === props.modelValue) || null);

function toggle() {
  if (props.disabled) return;
  if (!open.value) {
    const mobile = window.matchMedia("(max-width: 760px)").matches;
    lockScroll.value = mobile;
    if (mobile) {
      panelStyle.value = {};
    } else {
      const rect = root.value?.getBoundingClientRect();
      panelStyle.value = rect
        ? { position: "fixed", left: `${rect.left}px`, top: `${rect.bottom + 6}px`, width: `${rect.width}px` }
        : {};
    }
  }
  open.value = !open.value;
}

function pick(option: Option) {
  if (option.disabled) return;
  emit("update:modelValue", option.value);
  emit("change", option.value);
  open.value = false;
}

function onDocPointerDown(event: Event) {
  const target = event.target as Node;
  if (root.value?.contains(target) || layer.value?.contains(target)) return;
  open.value = false;
}
function onKeydown(event: Event) {
  if (event instanceof KeyboardEvent && event.key === "Escape") open.value = false;
}

watch(open, (value) => {
  const action = value ? "addEventListener" : "removeEventListener";
  document[action]("mousedown", onDocPointerDown);
  document[action]("touchstart", onDocPointerDown);
  window[action]("keydown", onKeydown);
});
onBeforeUnmount(() => {
  document.removeEventListener("mousedown", onDocPointerDown);
  document.removeEventListener("touchstart", onDocPointerDown);
  window.removeEventListener("keydown", onKeydown);
});
</script>

<template>
  <div ref="root" class="form-select" :class="{ open, disabled }">
    <button
      type="button" class="form-select-trigger" :disabled="disabled"
      :aria-label="ariaLabel" :aria-expanded="open" aria-haspopup="listbox"
      @click="toggle"
    >
      <span :class="{ placeholder: !current }">{{ current?.label || placeholder || "请选择" }}</span>
      <ChevronDown :size="16" class="form-select-caret" />
    </button>
    <Teleport to="body">
      <div v-if="open" ref="layer" class="form-select-layer" @mousedown.self="open = false" @touchstart.self="open = false">
        <div class="form-select-panel" :style="panelStyle" role="listbox" :aria-label="ariaLabel">
          <span class="sheet-grabber" aria-hidden="true"></span>
          <button
            v-for="option in options"
            :key="option.value"
            type="button"
            class="form-select-option"
            :class="{ selected: option.value === modelValue }"
            :disabled="option.disabled"
            role="option"
            :aria-selected="option.value === modelValue"
            @click="pick(option)"
          >
            <span>{{ option.label }}</span>
            <Check v-if="option.value === modelValue" :size="16" />
          </button>
        </div>
      </div>
    </Teleport>
  </div>
</template>
