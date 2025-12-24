import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type Transport = "stdio" | "http" | "sse";

export type ToolConfig = {
  allow: string[];
  aliases?: Record<string, string>;
};

export type AuthConfig = {
  type: "bearer" | "basic" | "apiKey";
  credentialRef: string;
  headerName?: string;
  queryParam?: string;
};

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

export type LoadOptions = {
  manifestPath?: string;
  profile?: string;
};

function getDefaultConfigDir(): string {
  const home = os.homedir();
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", "mini-mcp");
  }
  return path.join(home, ".config", "mini-mcp");
}

export function getDefaultManifestPath(): string {
  return path.join(getDefaultConfigDir(), "manifest.json");
}

export function resolveManifestPath(
  manifestPath?: string,
  envValue = process.env.MINI_MCP_MANIFEST,
): string {
  return manifestPath ?? envValue ?? getDefaultManifestPath();
}

export function loadManifest(manifestPath: string): Manifest {
  const raw = fs.readFileSync(manifestPath, "utf-8");
  return JSON.parse(raw) as Manifest;
}

export function selectProfile(
  manifest: Manifest,
  profile?: string,
): ProfileConfig {
  const active = profile ?? manifest.activeProfile;
  const config = manifest.profiles[active];
  if (!config) {
    throw new Error(`Profile not found: ${active}`);
  }
  return config;
}
