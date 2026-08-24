import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { fileURLToPath, URL } from "node:url";
import templateConfig from "../../template.config.json" with { type: "json" };

const appPort = Number(process.env.APP_PORT || templateConfig.localDevPort);
const webPort = Number(process.env.WEB_PORT || appPort + 1);
const configuredPrefix = process.env.GATEWAY_PREFIX ?? templateConfig.gatewayPrefix;
const gatewayPrefix = configuredPrefix === "/"
  ? ""
  : `/${configuredPrefix.replace(/^\/+|\/+$/g, "")}`;

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: gatewayPrefix ? `${gatewayPrefix}/` : "/",
  plugins: [vue()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url))
    }
  },
  server: {
    host: "0.0.0.0",
    port: webPort,
    strictPort: true,
    proxy: {
      [`${gatewayPrefix}/api`]: `http://127.0.0.1:${appPort}`,
      [`${gatewayPrefix}/healthz`]: `http://127.0.0.1:${appPort}`
    }
  },
  build: {
    outDir: fileURLToPath(new URL("../../.ui-dist", import.meta.url)),
    emptyOutDir: true,
    /*
     * fnOS App 内嵌 WebView 可能是多年未更新的出厂内核（如 Android 11 出厂 Chromium 83）。
     * Vue 3.5 运行时会用到 ??= / ||= / &&=（Chrome 85+），按 chrome80/safari13 降级编译，
     * 老内核不会因 SyntaxError 整包白屏。
     */
    target: ["chrome80", "safari13", "edge80", "firefox78"]
  }
});
