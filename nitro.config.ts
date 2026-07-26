import templateConfig from "./template.config.json" with { type: "json" };
import { defineNitroConfig } from "nitro/config";

export default defineNitroConfig({
  preset: "node-middleware",
  baseURL: `${templateConfig.gatewayPrefix}/`,
  serverDir: "packages/server",
  errorHandler: "packages/server/error-handler.ts",
  output: {
    dir: ".server-dist"
  },
  publicAssets: [
    {
      dir: ".ui-dist",
      maxAge: 0
    }
  ],
  runtimeConfig: {
    appName: templateConfig.appName,
    appTitle: templateConfig.appTitle,
    appPort: templateConfig.localDevPort,
    logLevel: templateConfig.logLevel,
    logDir: `/var/apps/${templateConfig.appName}/var/log`,
    storageDir: `/var/apps/${templateConfig.appName}/var/data`,
    directPort: templateConfig.localDevPort
  },
  routeRules: {
    "/": {
      prerender: false
    },
    "/healthz": {
      headers: {
        "cache-control": "no-store"
      }
    }
  }
});
