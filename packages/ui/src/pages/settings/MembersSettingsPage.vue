<script setup lang="ts">
import MemberManager from "../../components/MemberManager.vue";
import SubPageHeader from "../../components/SubPageHeader.vue";
</script>

<template>
  <section class="settings-page">
    <SubPageHeader title="家庭成员" description="添加家庭成员并管理自己有权限的成员资料" />
    <MemberManager />
  </section>
</template>
