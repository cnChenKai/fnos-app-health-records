import type { H3Event } from "h3";

export type GatewayUser = {
  authenticated: boolean;
  uid: string | null;
  username: string | null;
  isAdmin: boolean;
};

export function getGatewayUser(event: H3Event): GatewayUser {
  const request = event.node!.req!;
  const accessMode = (request as typeof request & { healthAccessMode?: string }).healthAccessMode;
  // The launcher marks Unix Socket requests in-process. TCP clients cannot forge this property.
  if (accessMode !== "gateway") {
    return {
      authenticated: false,
      uid: null,
      username: null,
      isAdmin: false
    };
  }

  const rawUid = request.headers["x-trim-userid"];
  const rawUsername = request.headers["x-trim-username"];
  const uid = typeof rawUid === "string" ? rawUid : null;
  const username = typeof rawUsername === "string" ? rawUsername : null;

  return {
    authenticated: Boolean(uid),
    uid,
    username,
    isAdmin: String(request.headers["x-trim-isadmin"] || "").toLowerCase() === "true"
  };
}
