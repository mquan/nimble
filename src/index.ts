import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import path from "node:path";
import http from "node:http";
import fs from "node:fs";
import type {
  OAuthAuthConfig,
  ProfileConfig,
  ServerConfig,
  Transport,
} from "./config.js";
import {
  loadManifest,
  resolveManifestPath,
  saveManifest,
  selectProfile,
} from "./config.js";
import { CredentialStore } from "./credentials.js";
import { StoredOAuthProvider } from "./oauth.js";
import { ToolRegistry } from "./registry.js";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";

const TOOL_DEFS = [
  {
    name: "list-available-tools",
    description: "List available tools with name and summary.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "get-tool",
    description: "Get the full tool detail for a tool name.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "execute-tool",
    description: "Execute a tool by name with arguments.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        arguments: { type: "object" },
      },
      required: ["name", "arguments"],
      additionalProperties: false,
    },
  },
] as const;

const server = new Server(
  { name: "mini-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

function getArgValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) {
    return undefined;
  }
  return process.argv[idx + 1];
}

function normalizeUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

const manifestPath = resolveManifestPath(getArgValue("--manifest"));
const authCommand = process.argv[2];
if (authCommand === "auth") {
  await handleAuthCommand(manifestPath);
  process.exit(0);
}
const manifest = loadManifest(manifestPath);
const profileName = getArgValue("--profile") ?? manifest.activeProfile;
const profile = selectProfile(manifest, profileName);

const oauthServerName = getArgValue("--oauth-server");
const oauthServerUrl = getArgValue("--server-url");
const oauthTransport = getArgValue("--transport");
const oauthCode = getArgValue("--oauth-code");
if (oauthServerName || oauthServerUrl) {
  const selection: OAuthSelection = {
    name: oauthServerName,
    url: oauthServerUrl,
    transport: normalizeTransport(oauthTransport),
  };
  const resolvedServer = ensureOAuthServer(
    manifest,
    profile,
    profileName,
    manifestPath,
    selection,
  );
  assertOAuthServerConfig(resolvedServer);
  console.log(
    `Starting OAuth flow for ${resolvedServer.name} (${resolvedServer.url})`,
  );
  const credentialStore = new CredentialStore({ manifestPath });
  const provider = new StoredOAuthProvider(credentialStore, resolvedServer.auth);
  if (oauthCode) {
    const result = await auth(provider, {
      serverUrl: resolvedServer.url,
      authorizationCode: oauthCode,
      scope: resolvedServer.auth.scope,
    });
    console.log(`OAuth result: ${result}`);
  } else {
    const redirectUrl = getRedirectUrl(resolvedServer);
    const codePromise = startLocalCallbackServer(redirectUrl);
    const result = await auth(provider, {
      serverUrl: resolvedServer.url,
      scope: resolvedServer.auth.scope,
    });
    console.log(`OAuth result: ${result}`);
    if (result === "REDIRECT") {
      const code = await codePromise;
      const finalResult = await auth(provider, {
        serverUrl: resolvedServer.url,
        authorizationCode: code,
        scope: resolvedServer.auth.scope,
      });
      console.log(`OAuth result: ${finalResult}`);
    }
  }
  process.exit(0);
}

const credentialStore = new CredentialStore({ manifestPath });
const cachePath = path.join(path.dirname(manifestPath), "tools-cache.json");
const registry = new ToolRegistry(profile, credentialStore, cachePath);
await registry.initialize();

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: [...TOOL_DEFS] };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  if (name === "list-available-tools") {
    const summaries = registry.listSummaries();
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(summaries),
        },
      ],
    };
  }

  if (name === "get-tool") {
    const tool = registry.getTool((args?.name as string) ?? "");
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ tool, name: args?.name ?? null }),
        },
      ],
    };
  }

  if (name === "execute-tool") {
    if (!args || typeof args !== "object") {
      throw new Error("execute-tool requires arguments");
    }
    const targetName = args.name as string;
    const toolArgs = (args.arguments ?? {}) as Record<string, unknown>;
    return registry.execute(targetName, toolArgs);
  }

  throw new Error(`Unknown tool: ${name}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);

function normalizeTransport(value?: string): Transport | undefined {
  if (!value) {
    return undefined;
  }
  if (value === "streamableHttp") {
    return "http";
  }
  if (value === "http" || value === "sse" || value === "stdio") {
    return value;
  }
  throw new Error(`Unsupported transport: ${value}`);
}

type OAuthSelection = {
  name?: string;
  url?: string;
  transport?: Transport;
};

function ensureOAuthServer(
  manifest: ReturnType<typeof loadManifest>,
  profile: ProfileConfig,
  profileName: string,
  manifestPath: string,
  selection: OAuthSelection,
): ServerConfig {
  const existing = findServer(profile, selection);
  if (existing) {
    return existing;
  }
  if (!selection.url) {
    const target = selection.name ?? "unknown";
    throw new Error(
      `OAuth server not found: ${target}. Add a matching server entry to the manifest.`,
    );
  }
  const url = normalizeUrl(selection.url);
  const name = buildServerName(url, profile.servers.map((server) => server.name));
  const transport: Transport = selection.transport ?? "http";
  const redirectUrl = "http://127.0.0.1:8787/callback";
  const credentialRef = `${name}-oauth`;
  const server: ServerConfig = {
    name,
    transport,
    url: selection.url,
    tools: { allow: ["*"] },
    auth: {
      type: "oauth",
      credentialRef,
      redirectUrl,
      clientMetadata: {
        client_name: "mini-mcp",
        redirect_uris: [redirectUrl],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
    },
  };
  profile.servers.push(server);
  manifest.profiles[profileName] = profile;
  saveManifest(manifestPath, manifest);
  return server;
}

function assertOAuthServerConfig(
  server: ServerConfig,
): asserts server is ServerConfig & { url: string; auth: OAuthAuthConfig } {
  if (!server.auth || server.auth.type !== "oauth") {
    throw new Error(`Server ${server.name} is not configured for OAuth`);
  }
  if (!server.url) {
    throw new Error(`Server ${server.name} is missing url`);
  }
  const redirectUris = (
    server.auth.clientMetadata as { redirect_uris?: string[] }
  ).redirect_uris;
  if (!server.auth.redirectUrl && !redirectUris?.length) {
    throw new Error(
      `OAuth server ${server.name} requires a redirect URL in auth.redirectUrl or clientMetadata.redirect_uris`,
    );
  }
}

function getRedirectUrl(server: ServerConfig): string {
  const redirectUris = (
    server.auth?.type === "oauth"
      ? (server.auth.clientMetadata as { redirect_uris?: string[] })
      : {}
  ).redirect_uris;
  const redirectUrl =
    server.auth?.type === "oauth" ? server.auth.redirectUrl : undefined;
  const resolved = redirectUrl ?? redirectUris?.[0];
  if (!resolved) {
    throw new Error(`Missing redirect URL for ${server.name}`);
  }
  return resolved;
}

function findServer(
  profile: ProfileConfig,
  selection: OAuthSelection,
): ServerConfig | undefined {
  const normalizedTargetUrl = selection.url
    ? normalizeUrl(selection.url)
    : undefined;
  return profile.servers.find((server) =>
    matchesServer(server, selection, normalizedTargetUrl),
  );
}

function matchesServer(
  server: ServerConfig,
  selection: OAuthSelection,
  normalizedTargetUrl?: string,
): boolean {
  if (selection.name && server.name !== selection.name) {
    return false;
  }
  if (normalizedTargetUrl) {
    if (!server.url) {
      return false;
    }
    const normalizedServerUrl = normalizeUrl(server.url);
    if (
      normalizedServerUrl !== normalizedTargetUrl &&
      !normalizedServerUrl.startsWith(normalizedTargetUrl) &&
      !normalizedTargetUrl.startsWith(normalizedServerUrl)
    ) {
      return false;
    }
  }
  if (selection.transport && server.transport !== selection.transport) {
    return false;
  }
  return true;
}

function buildServerName(urlValue: string, taken: string[]): string {
  const hostname = urlValue.replace(/^https?:\/\//, "").split("/")[0];
  let base = hostname.replace(/[^a-zA-Z0-9_-]/g, "-");
  if (!base) {
    base = "server";
  }
  let name = base;
  let idx = 2;
  while (taken.includes(name)) {
    name = `${base}-${idx}`;
    idx += 1;
  }
  return name;
}

function startLocalCallbackServer(redirectUrl: string): Promise<string> {
  const url = new URL(redirectUrl);
  if (url.protocol !== "http:") {
    throw new Error("Redirect URL must be http:// for local callback.");
  }
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
    throw new Error("Redirect URL host must be 127.0.0.1 or localhost.");
  }
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (!req.url) {
        res.statusCode = 400;
        res.end("Missing URL");
        return;
      }
      const reqUrl = new URL(req.url, redirectUrl);
      const code = reqUrl.searchParams.get("code");
      if (!code) {
        res.statusCode = 400;
        res.end("Missing code");
        return;
      }
      res.statusCode = 200;
      res.end("Authorization complete. You may close this window.");
      server.close();
      resolve(code);
    });
    server.on("error", (err) => {
      reject(err);
    });
    server.listen(Number(url.port), url.hostname);
  });
}

async function handleAuthCommand(manifestPath: string): Promise<void> {
  const action = process.argv[3];
  const ref = process.argv[4];
  if (!action || !ref) {
    throw new Error("Usage: mini-mcp auth <set|get|remove|oauth-reset> <ref>");
  }
  const store = new CredentialStore({ manifestPath });
  if (action === "set") {
    const value = process.argv[5] ?? readStdin().trim();
    if (!value) {
      throw new Error("Missing credential value");
    }
    store.set(ref, value);
    console.log(`Saved credential: ${ref}`);
    return;
  }
  if (action === "get") {
    const value = store.get(ref);
    if (!value) {
      console.log("");
      return;
    }
    console.log(value);
    return;
  }
  if (action === "remove") {
    store.remove(ref);
    console.log(`Removed credential: ${ref}`);
    return;
  }
  if (action === "oauth-reset") {
    store.remove(`${ref}:tokens`);
    store.remove(`${ref}:client`);
    store.remove(`${ref}:verifier`);
    console.log(`Reset OAuth credentials: ${ref}`);
    return;
  }
  throw new Error("Unknown auth action");
}

function readStdin(): string {
  return fs.readFileSync(0, "utf8");
}
