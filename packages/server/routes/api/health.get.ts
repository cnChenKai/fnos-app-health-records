import { defineEventHandler } from "h3";
import { ok } from "../../utils/api-response";
import { getRequestAccessMode } from "../../utils/access-mode";
import { getAppConfig } from "../../utils/runtime-config";

export default defineEventHandler((event) => {
  const config = getAppConfig();

  return ok({
    service: config.appName,
    runtime: "nitro",
    accessMode: getRequestAccessMode(event),
    gatewayPrefix: config.gatewayPrefix,
    port: config.appPort,
    servicePort: config.servicePort
  });
});
