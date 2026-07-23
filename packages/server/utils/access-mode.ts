import type { H3Event } from "h3";
import { getAppConfig } from "./runtime-config";

export type RequestAccessMode = "gateway" | "port";

export function getRequestAccessMode(event: H3Event): RequestAccessMode {
  const request = event.node!.req!;
  const markedMode = (request as typeof request & { healthAccessMode?: string }).healthAccessMode;
  if (markedMode === "gateway" || markedMode === "port") return markedMode;
  return getAppConfig().accessMode === "gateway" ? "gateway" : "port";
}
