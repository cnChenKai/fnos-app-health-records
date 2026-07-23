export type IdentityProvider = "fnos_gateway" | "local" | "development";

export type RequestUser = {
  id: string;
  displayName: string;
  provider: IdentityProvider;
  authenticated: boolean;
  isGatewayAdmin: boolean;
};
