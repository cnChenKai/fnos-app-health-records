<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { Check, X } from "@lucide/vue";
import { useScrollLock } from "../composables/useScrollLock";

const props = defineProps<{
  modelValue: string | null;
  label?: string;
  disabled?: boolean;
  showTime?: boolean;
  ariaLabel?: string;
}>();
const emit = defineEmits<{ "update:modelValue": [value: string | null] }>();

const isMobile = ref(false);
onMounted(() => {
  isMobile.value = window.matchMedia("(max-width: 760px)").matches;
});

const open = ref(false);
const root = ref<HTMLElement | null>(null);
const layer = ref<HTMLElement | null>(null);
const lockScroll = ref(false);
useScrollLock(computed(() => open.value && lockScroll.value));

// 解析当前值
const parsedDate = computed(() => {
  if (!props.modelValue) return null;
  const match = props.modelValue.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!match) return null;
  return {
    year: parseInt(match[1]),
    month: parseInt(match[2]),
    day: parseInt(match[3]),
    hour: match[4] ? parseInt(match[4]) : 0,
    minute: match[5] ? parseInt(match[5]) : 0,
  };
});

// 滚轮选中值
const selectedYear = ref(new Date().getFullYear());
const selectedMonth = ref(1);
const selectedDay = ref(1);
const selectedHour = ref(0);
const selectedMinute = ref(0);

watch(open, (value) => {
  if (value) {
    // 打开时初始化选中值
    if (parsedDate.value) {
      selectedYear.value = parsedDate.value.year;
      selectedMonth.value = parsedDate.value.month;
      selectedDay.value = parsedDate.value.day;
      selectedHour.value = parsedDate.value.hour;
      selectedMinute.value = parsedDate.value.minute;
    } else {
      const now = new Date();
      selectedYear.value = now.getFullYear();
      selectedMonth.value = now.getMonth() + 1;
      selectedDay.value = now.getDate();
      selectedHour.value = now.getHours();
      selectedMinute.value = now.getMinutes();
    }
    // 等待 DOM 更新后滚动到选中位置
    nextTick(() => {
      scrollToSelected();
    });
  }
});

// 生成滚轮数据
const years = computed(() => {
  const current = new Date().getFullYear();
  return Array.from({ length: 21 }, (_, i) => current - 10 + i);
});

const months = computed(() => Array.from({ length: 12 }, (_, i) => i + 1));

const days = computed(() => {
  const daysInMonth = new Date(selectedYear.value, selectedMonth.value, 0).getDate();
  return Array.from({ length: daysInMonth }, (_, i) => i + 1);
});

const hours = computed(() => Array.from({ length: 24 }, (_, i) => i));
const minutes = computed(() => Array.from({ length: 60 }, (_, i) => i));

// 格式化显示
function padZero(n: number): string {
  return n.toString().padStart(2, "0");
}

function formatValue(): string | null {
  const y = selectedYear.value;
  const m = padZero(selectedMonth.value);
  const d = padZero(selectedDay.value);
  if (!props.showTime) return `${y}-${m}-${d}`;
  const h = padZero(selectedHour.value);
  const min = padZero(selectedMinute.value);
  return `${y}-${m}-${d}T${h}:${min}`;
}

function displayValue(): string {
  if (!parsedDate.value) return props.label || "请选择";
  const { year, month, day, hour, minute } = parsedDate.value;
  if (!props.showTime) return `${year}-${padZero(month)}-${padZero(day)}`;
  return `${year}-${padZero(month)}-${padZero(day)} ${padZero(hour)}:${padZero(minute)}`;
}

// 滚轮滚动处理（带自动吸附）
let scrollTimers: Record<string, ReturnType<typeof setTimeout>> = {};
const ITEM_HEIGHT = 40;
const HIGHLIGHT_TOP = 4; // 高亮框距离顶部的距离

function onScroll(e: Event, type: "year" | "month" | "day" | "hour" | "minute") {
  const el = e.target as HTMLElement;
  const scrollTop = el.scrollTop;

  // 计算当前选中的索引（考虑高亮框偏移）
  const adjustedScrollTop = scrollTop - HIGHLIGHT_TOP;
  const index = Math.round(adjustedScrollTop / ITEM_HEIGHT);

  // 更新选中值
  switch (type) {
    case "year": selectedYear.value = years.value[index]; break;
    case "month": selectedMonth.value = months.value[index]; break;
    case "day": selectedDay.value = days.value[index] ?? 1; break;
    case "hour": selectedHour.value = hours.value[index]; break;
    case "minute": selectedMinute.value = minutes.value[index]; break;
  }

  // 清除之前的定时器
  if (scrollTimers[type]) {
    clearTimeout(scrollTimers[type]);
  }

  // 设置新的定时器，滚动停止后自动吸附
  scrollTimers[type] = setTimeout(() => {
    snapToNearest(el, type);
  }, 100);
}

// 自动吸附到最近的选项
function snapToNearest(el: HTMLElement, type: "year" | "month" | "day" | "hour" | "minute") {
  let currentValue: number;
  let options: number[];

  switch (type) {
    case "year": currentValue = selectedYear.value; options = years.value; break;
    case "month": currentValue = selectedMonth.value; options = months.value; break;
    case "day": currentValue = selectedDay.value; options = days.value; break;
    case "hour": currentValue = selectedHour.value; options = hours.value; break;
    case "minute": currentValue = selectedMinute.value; options = minutes.value; break;
  }

  const index = options.indexOf(currentValue);
  if (index >= 0) {
    // 计算目标滚动位置，使选项居中在高亮框内
    const targetScrollTop = index * ITEM_HEIGHT + HIGHLIGHT_TOP;
    el.scrollTo({
      top: targetScrollTop,
      behavior: 'smooth'
    });
  }
}

// 滚动到指定位置（考虑高亮框偏移）
function scrollToItem(el: HTMLElement, index: number) {
  el.scrollTop = index * ITEM_HEIGHT + HIGHLIGHT_TOP;
}

// 滚动到选中位置
function scrollToSelected() {
  const wheelScrolls = document.querySelectorAll('.wheel-scroll');
  if (wheelScrolls.length === 0) return;

  // 计算各滚轮的选中索引
  const yearIndex = years.value.indexOf(selectedYear.value);
  const monthIndex = months.value.indexOf(selectedMonth.value);
  const dayIndex = days.value.indexOf(selectedDay.value);
  const hourIndex = hours.value.indexOf(selectedHour.value);
  const minuteIndex = minutes.value.indexOf(selectedMinute.value);

  const indices = [yearIndex, monthIndex, dayIndex];
  if (props.showTime) {
    indices.push(hourIndex, minuteIndex);
  }

  // 滚动到对应位置
  wheelScrolls.forEach((el, i) => {
    if (indices[i] >= 0) {
      scrollToItem(el as HTMLElement, indices[i]);
    }
  });
}

// 确认选择
function confirm() {
  emit("update:modelValue", formatValue());
  open.value = false;
}

// 取消
function cancel() {
  open.value = false;
}

// 点击外部关闭
function onDocPointerDown(event: Event) {
  const target = event.target as Node;
  if (root.value?.contains(target) || layer.value?.contains(target)) return;
  open.value = false;
}

watch(open, (value) => {
  const action = value ? "addEventListener" : "removeEventListener";
  document[action]("mousedown", onDocPointerDown);
  document[action]("touchstart", onDocPointerDown);
});

onBeforeUnmount(() => {
  document.removeEventListener("mousedown", onDocPointerDown);
  document.removeEventListener("touchstart", onDocPointerDown);
});
</script>

<template>
  <div ref="root" class="datetime-picker" :class="{ disabled }">
    <!-- 桌面端：原生输入框 -->
    <input
      v-if="!isMobile"
      type="datetime-local"
      :value="modelValue || ''"
      :disabled="disabled"
      :aria-label="ariaLabel"
      @input="emit('update:modelValue', ($event.target as HTMLInputElement).value || null)"
    />

    <!-- 手机端：自定义滚轮 -->
    <template v-else>
      <button
        type="button"
        class="datetime-picker-trigger"
        :disabled="disabled"
        :aria-label="ariaLabel"
        @click="open = true"
      >
        <span :class="{ placeholder: !modelValue }">{{ displayValue() }}</span>
      </button>
      <Teleport to="body">
        <div v-if="open" ref="layer" class="datetime-picker-layer" @mousedown.self="cancel" @touchstart.self="cancel">
          <div class="datetime-picker-panel">
            <div class="datetime-picker-header">
              <button type="button" class="datetime-picker-cancel" @click="cancel">
                <X :size="18" />
              </button>
              <span class="datetime-picker-title">{{ label || "请选择时间" }}</span>
              <button type="button" class="datetime-picker-confirm" @click="confirm">
                <Check :size="18" />
              </button>
            </div>
            <div class="datetime-picker-wheels">
              <div class="datetime-picker-wheel">
                <span class="wheel-label">年</span>
                <div class="wheel-scroll-wrapper">
                  <div class="wheel-highlight"></div>
                  <div class="wheel-scroll" @scroll="onScroll($event, 'year')">
                    <div class="wheel-item" v-for="y in years" :key="y" :class="{ selected: y === selectedYear }">{{ y }}</div>
                  </div>
                </div>
              </div>
              <div class="datetime-picker-wheel">
                <span class="wheel-label">月</span>
                <div class="wheel-scroll-wrapper">
                  <div class="wheel-highlight"></div>
                  <div class="wheel-scroll" @scroll="onScroll($event, 'month')">
                    <div class="wheel-item" v-for="m in months" :key="m" :class="{ selected: m === selectedMonth }">{{ padZero(m) }}</div>
                  </div>
                </div>
              </div>
              <div class="datetime-picker-wheel">
                <span class="wheel-label">日</span>
                <div class="wheel-scroll-wrapper">
                  <div class="wheel-highlight"></div>
                  <div class="wheel-scroll" @scroll="onScroll($event, 'day')">
                    <div class="wheel-item" v-for="d in days" :key="d" :class="{ selected: d === selectedDay }">{{ padZero(d) }}</div>
                  </div>
                </div>
              </div>
              <template v-if="showTime">
                <div class="datetime-picker-wheel">
                  <span class="wheel-label">时</span>
                  <div class="wheel-scroll-wrapper">
                    <div class="wheel-highlight"></div>
                    <div class="wheel-scroll" @scroll="onScroll($event, 'hour')">
                      <div class="wheel-item" v-for="h in hours" :key="h" :class="{ selected: h === selectedHour }">{{ padZero(h) }}</div>
                    </div>
                  </div>
                </div>
                <div class="datetime-picker-wheel">
                  <span class="wheel-label">分</span>
                  <div class="wheel-scroll-wrapper">
                    <div class="wheel-highlight"></div>
                    <div class="wheel-scroll" @scroll="onScroll($event, 'minute')">
                      <div class="wheel-item" v-for="min in minutes" :key="min" :class="{ selected: min === selectedMinute }">{{ padZero(min) }}</div>
                    </div>
                  </div>
                </div>
              </template>
            </div>
          </div>
        </div>
      </Teleport>
    </template>
  </div>
</template>

<style scoped>
.datetime-picker { display: block; width: 100%; }

.datetime-picker input {
  display: block; width: 100%; min-height: 44px; padding-block: 0;
  line-height: normal; text-align: left; font-variant-numeric: tabular-nums;
}

.datetime-picker-trigger {
  display: flex; align-items: center; width: 100%; min-height: 44px;
  padding: 0 12px; border: 1px solid var(--line); border-radius: 10px;
  background: var(--fill-1); color: var(--ink); font-size: 15px;
  text-align: left; cursor: pointer; transition: border-color .15s;
}
.datetime-picker-trigger:focus { border-color: var(--brand); outline: none; }
.datetime-picker-trigger .placeholder { color: var(--muted); }
</style>
