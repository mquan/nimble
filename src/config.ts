import path from "node:path";

export type Transport = "stdio" | "http" | "sse";

export type ToolConfig = {
  aliases?: Record<string, string>;
};

export type BearerAuthConfig = {
  type: "bearer";
  credentialRef: string;
};

export type BasicAuthConfig = {
  type: "basic";
  credentialRef: string;
};

export type ApiKeyAuthConfig = {
  type: "apiKey";
  credentialRef: string;
  headerName?: string;
  queryParam?: string;
};

export type OAuthAuthConfig = {
  type: "oauth";
  credentialRef: string;
  clientMetadata: Record<string, unknown>;
  redirectUrl?: string;
  scope?: string;
};

export type AuthConfig =
  | BearerAuthConfig
  | BasicAuthConfig
  | ApiKeyAuthConfig
  | OAuthAuthConfig;

export type ServerConfig = {
  name: string;
  transport: Transport;
  command?: string;
  args?: string[];
  url?: string;
  tools?: ToolConfig;
  auth?: AuthConfig;
};

export type ProfileConfig = {
  servers: ServerConfig[];
};

export type Manifest = {
  activeProfile: string;
  profiles: Record<string, ProfileConfig>;
};

export function resolveDbPath(
  dbPath?: string,
  envValue = process.env.MINI_MCP_DB_PATH,
): string {
  const resolved = dbPath ?? envValue ?? path.join(process.cwd(), "mini-mcp.sqlite");
  return path.resolve(resolved);
}
