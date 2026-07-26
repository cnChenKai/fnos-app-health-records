import { createApp } from "vue";
import App from "./App.vue";
import router from "./router";
import { useToast } from "./composables/useToast";
import { describeTechnical } from "./utils/error";
import "./styles.css";

const app = createApp(App);

/* 全局兜底：任何漏网的同步渲染错误或未捕获 rejection 都留痕并提示，杜绝“点了没反应” */
app.config.errorHandler = (error, instance, info) => {
  console.error("[health-records] 未处理的界面错误", { error, info, component: instance?.$?.type?.name });
};

window.addEventListener("unhandledrejection", (event) => {
  console.error("[health-records] 未处理的异步异常", event.reason);
  useToast().show(`操作未生效，请重试（${describeTechnical(event.reason)}）`, 3600);
});

app.use(router).mount("#app");
