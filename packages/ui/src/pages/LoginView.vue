<script setup lang="ts">
import { ShieldCheck } from "@lucide/vue";
import appIcon from "../assets/app-icon.png";
</script>

<template>
  <main class="login-page">
    <section class="login-panel">
      <span class="login-icon"><img :src="appIcon" alt="" /></span>
      <div><h1>健康档案</h1><p>请从 fnOS 桌面或应用网关打开，应用管理员跟随 fnOS 系统管理员身份。</p></div>
      <p class="login-notice"><ShieldCheck :size="18" />当前请求没有 fnOS 登录态，健康档案不提供独立账号登录。</p>
    </section>
  </main>
</template>
