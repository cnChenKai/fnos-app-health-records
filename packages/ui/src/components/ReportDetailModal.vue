<script setup lang="ts">
import { computed } from "vue";
import { useRouter } from "vue-router";
import ReportDetail from "./ReportDetail.vue";
import { useScrollLock } from "../composables/useScrollLock";
import type { ReportDetail as ReportDetailType } from "../types/api";

type DuplicateCandidate = ReportDetailType["duplicateCandidates"][number];

const props = defineProps<{ open: boolean; reportId: string | null }>();
const emit = defineEmits<{ close: []; updated: [] }>();
const router = useRouter();
useScrollLock(computed(() => props.open));

function onOpenCandidate(candidate: DuplicateCandidate) {
  emit("close");
  router.push({ path: "/records", query: { reportId: candidate.id } })
    .catch((cause) => console.warn("[health-records] 打开已有报告跳转失败", cause));
}
</script>

<template>
  <Teleport to="body">
    <div v-if="props.open && props.reportId" class="modal-backdrop" @click.self="emit('close')">
      <section class="modal-panel duplicate-detail-modal report-detail-modal" role="dialog" aria-modal="true" aria-label="报告详情">
        <ReportDetail
          :report-id="props.reportId"
          variant="floating"
          @close="emit('close')"
          @updated="emit('updated')"
          @open-candidate="onOpenCandidate"
        />
      </section>
    </div>
  </Teleport>
</template>
