import { defineEventHandler } from "h3";
import { ok } from "../../utils/api-response";
import { getRequestAccessMode } from "../../utils/access-mode";
import { getAppConfig } from "../../utils/runtime-config";

export default defineEventHandler((event) => {
  const config = getAppConfig();

  return ok({
    appName: config.appName,
    appTitle: config.appTitle,
    accessMode: getRequestAccessMode(event),
    gatewayPrefix: config.gatewayPrefix,
    appPort: config.appPort,
    servicePort: config.servicePort,
    logLevel: config.logLevel
  });
});
