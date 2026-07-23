import { computed, readonly, ref, watch } from "vue";

export type ThemeSetting = "system" | "light" | "dark";
const STORAGE_KEY = "health-records:theme";

const stored = localStorage.getItem(STORAGE_KEY);
const setting = ref<ThemeSetting>(stored === "light" || stored === "dark" ? stored : "system");
const systemDark = ref(window.matchMedia("(prefers-color-scheme: dark)").matches);

window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (event) => {
  systemDark.value = event.matches;
});

const effective = computed<"light" | "dark">(() =>
  setting.value === "system" ? (systemDark.value ? "dark" : "light") : setting.value
);

watch([setting, systemDark], () => {
  const root = document.documentElement;
  if (setting.value === "system") delete root.dataset.theme;
  else root.dataset.theme = setting.value;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", effective.value === "dark" ? "#151716" : "#0e7c6b");
}, { immediate: true });

watch(setting, (value) => {
  localStorage.setItem(STORAGE_KEY, value);
});

export function useTheme() {
  return { setting, effective: readonly(effective) };
}
