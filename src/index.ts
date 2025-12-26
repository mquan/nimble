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
const primaryCommand = process.argv[2];
if (primaryCommand === "auth") {
  await handleAuthCommand(manifestPath);
  process.exit(0);
}
if (primaryCommand === "discover" || primaryCommand === "connect") {
  await handleConnectCommand(manifestPath);
  process.exit(0);
}
const manifest = loadManifest(manifestPath);
const profileName = getArgValue("--profile") ?? manifest.activeProfile;
const profile = selectProfile(manifest, profileName);
pruneToolsCache(manifestPath, profile);

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
  await runOAuthFlow(resolvedServer, manifestPath, oauthCode);
  process.exit(0);
}

const credentialStore = new CredentialStore({ manifestPath });
const cachePath = path.join(path.dirname(manifestPath), "tools-cache.json");
const registry = new ToolRegistry(profile, credentialStore, cachePath);
await registry.initialize();

const uiPort = Number(process.env.MINI_MCP_UI_PORT ?? 3000);
startHttpServer({
  port: uiPort,
  manifestPath,
  profileName,
});

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
    if (existing.auth?.type === "oauth") {
      return existing;
    }
    if (!selection.url) {
      throw new Error(
        `OAuth server not found: ${selection.name ?? "unknown"}. Add a matching server entry to the manifest.`,
      );
    }
    const redirectUrl = "http://127.0.0.1:8787/callback";
    existing.auth = buildOAuthAuth(existing.name, redirectUrl);
    existing.url = existing.url ?? selection.url;
    existing.transport = existing.transport ?? selection.transport ?? "http";
    manifest.profiles[profileName] = profile;
    saveManifest(manifestPath, manifest);
    return existing;
  }
  if (!selection.url) {
    const target = selection.name ?? "unknown";
    throw new Error(
      `OAuth server not found: ${target}. Add a matching server entry to the manifest.`,
    );
  }
  const urlMatch = findServerByUrl(profile, selection.url);
  if (urlMatch) {
    if (urlMatch.auth?.type !== "oauth") {
      urlMatch.auth = buildOAuthAuth(
        urlMatch.name,
        "http://127.0.0.1:8787/callback",
      );
    }
    urlMatch.transport = urlMatch.transport ?? selection.transport ?? "http";
    urlMatch.url = selection.url;
    manifest.profiles[profileName] = profile;
    saveManifest(manifestPath, manifest);
    return urlMatch;
  }
  const url = normalizeUrl(selection.url);
  const name = buildServerName(url, profile.servers.map((server) => server.name));
  const transport: Transport = selection.transport ?? "http";
  const server: ServerConfig = {
    name,
    transport,
    url: selection.url,
    tools: { allow: ["*"] },
    auth: buildOAuthAuth(name, "http://127.0.0.1:8787/callback"),
  };
  profile.servers.push(server);
  manifest.profiles[profileName] = profile;
  saveManifest(manifestPath, manifest);
  return server;
}

function buildOAuthAuth(name: string, redirectUrl: string): OAuthAuthConfig {
  const credentialRef = `${name}-oauth`;
  return {
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
  };
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

function findServerByUrl(
  profile: ProfileConfig,
  url: string,
): ServerConfig | undefined {
  const normalizedTargetUrl = normalizeUrl(url);
  return profile.servers.find((server) => {
    if (!server.url) {
      return false;
    }
    const normalizedServerUrl = normalizeUrl(server.url);
    return (
      normalizedServerUrl === normalizedTargetUrl ||
      normalizedServerUrl.startsWith(normalizedTargetUrl) ||
      normalizedTargetUrl.startsWith(normalizedServerUrl)
    );
  });
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

async function handleConnectCommand(manifestPath: string): Promise<void> {
  const args = parseArgs(process.argv.slice(3));
  const name = args["--name"];
  const url = args["--server-url"];
  const transportArg = normalizeTransport(args["--transport"]);
  const command = args["--command"];
  const commandArgs = args["--args"]?.split(",").filter(Boolean);

  if (!name) {
    throw new Error("connect requires --name");
  }

  const result = await connectAndDiscover(manifestPath, {
    name,
    transport: transportArg,
    url,
    command,
    args: commandArgs,
    profile: args["--profile"],
  });
  console.log(
    `Connected and discovered ${result.allow.length} tools for ${result.server.name}`,
  );
}

function parseArgs(argv: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith("--")) {
      continue;
    }
    const value = argv[i + 1];
    if (value && !value.startsWith("--")) {
      result[key] = value;
      i += 1;
    } else {
      result[key] = "true";
    }
  }
  return result;
}

type ConnectInput = {
  name: string;
  transport?: Transport;
  url?: string;
  command?: string;
  args?: string[];
  profile?: string;
};

async function connectAndDiscover(
  manifestPath: string,
  input: ConnectInput,
): Promise<{ server: ServerConfig; allow: string[] }> {
  const manifest = loadManifest(manifestPath);
  const profileName = input.profile ?? manifest.activeProfile;
  const profile = selectProfile(manifest, profileName);
  const existing = profile.servers.find((entry) => entry.name === input.name);
  const transport = input.transport ?? existing?.transport;
  if (!transport) {
    throw new Error("connect requires --transport or an existing server entry");
  }
  const server: ServerConfig = {
    name: input.name,
    transport,
    url: input.url ?? existing?.url,
    command: input.command ?? existing?.command,
    args: input.args ?? existing?.args,
    tools: existing?.tools ?? { allow: ["*"] },
    auth: existing?.auth,
  };
  if (transport === "stdio") {
    if (!server.command) {
      throw new Error("stdio connect requires --command");
    }
  } else if (!server.url) {
    throw new Error("http/sse connect requires --server-url");
  }

  const credentialStore = new CredentialStore({ manifestPath });
  const registry = new ToolRegistry(profile, credentialStore);
  let tools: Array<{ name: string; description?: string; inputSchema?: unknown }>;
  let activeServer = server;
  try {
    tools = await registry.discoverServerTools(activeServer);
  } catch (error) {
    if (isUnauthorizedError(error)) {
      if (activeServer.auth?.type === "oauth") {
        await runOAuthFlow(activeServer, manifestPath);
      } else if (
        activeServer.url &&
        (activeServer.transport === "http" || activeServer.transport === "sse")
      ) {
        const selection: OAuthSelection = {
          name: activeServer.name,
          url: activeServer.url,
          transport: activeServer.transport,
        };
        activeServer = ensureOAuthServer(
          manifest,
          profile,
          profileName,
          manifestPath,
          selection,
        );
        await runOAuthFlow(activeServer, manifestPath);
      } else {
        throw error;
      }
      tools = await registry.discoverServerTools(activeServer);
    } else {
      throw error;
    }
  }

  const allow = tools.map((tool) => tool.name);
  updateToolsCache(manifestPath, activeServer.name, tools);
  const existingIndex = profile.servers.findIndex((entry) => {
    if (entry.name === input.name) {
      return true;
    }
    if (server.url && entry.url) {
      const normalizedServerUrl = normalizeUrl(server.url);
      const normalizedEntryUrl = normalizeUrl(entry.url);
      return (
        normalizedServerUrl === normalizedEntryUrl ||
        normalizedServerUrl.startsWith(normalizedEntryUrl) ||
        normalizedEntryUrl.startsWith(normalizedServerUrl)
      );
    }
    return false;
  });
  const entry: ServerConfig = {
    ...activeServer,
    tools: { allow },
  };
  if (existingIndex >= 0) {
    profile.servers[existingIndex] = entry;
  } else {
    profile.servers.push(entry);
  }
  manifest.profiles[profileName] = profile;
  saveManifest(manifestPath, manifest);
  return { server: entry, allow };
}

type HttpServerOptions = {
  port: number;
  manifestPath: string;
  profileName: string;
};

function startHttpServer(options: HttpServerOptions): void {
  const uiDist = path.join(process.cwd(), "ui", "dist");
  const server = http.createServer(async (req, res) => {
    if (!req.url || !req.method) {
      sendText(res, 400, "Bad request");
      return;
    }
    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname.startsWith("/api/")) {
      try {
        await handleApiRequest(req, res, url, options.manifestPath, options.profileName);
      } catch (error) {
        sendJson(res, 500, { error: (error as Error).message });
      }
      return;
    }
    serveStatic(uiDist, url.pathname, res);
  });

  server.listen(options.port, () => {
    console.log(`mini-mcp UI listening on http://127.0.0.1:${options.port}`);
  });
}

async function handleApiRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  manifestPath: string,
  defaultProfile: string,
): Promise<void> {
  const profileName = url.searchParams.get("profile") ?? defaultProfile;
  const manifest = loadManifest(manifestPath);
  const profile = selectProfile(manifest, profileName);

  if (req.method === "GET" && url.pathname === "/api/servers") {
    sendJson(res, 200, { servers: profile.servers });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/servers") {
    const body = (await readJsonBody(req)) as ServerConfig;
    if (!body?.name || !body?.transport) {
      sendJson(res, 400, { error: "Server requires name and transport" });
      return;
    }
    const idx = profile.servers.findIndex(
      (entry) => entry.name === body.name || (entry.url && body.url && normalizeUrl(entry.url) === normalizeUrl(body.url)),
    );
    if (idx >= 0) {
      profile.servers[idx] = body;
    } else {
      profile.servers.push(body);
    }
    manifest.profiles[profileName] = profile;
    saveManifest(manifestPath, manifest);
    sendJson(res, 200, { server: body });
    return;
  }

  if (req.method === "DELETE" && url.pathname.startsWith("/api/servers/")) {
    const name = decodeURIComponent(url.pathname.replace("/api/servers/", ""));
    profile.servers = profile.servers.filter((server) => server.name !== name);
    manifest.profiles[profileName] = profile;
    saveManifest(manifestPath, manifest);
    removeToolsCacheEntry(manifestPath, name);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/connect") {
    const body = (await readJsonBody(req)) as ConnectInput;
    const result = await connectAndDiscover(manifestPath, {
      ...body,
      profile: profileName,
    });
    sendJson(res, 200, { server: result.server, allow: result.allow });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/tools") {
    const cache = readToolsCache(manifestPath);
    if (!cache) {
      sendJson(res, 404, { error: "tools-cache.json not found" });
      return;
    }
    sendJson(res, 200, cache);
    return;
  }

  sendJson(res, 404, { error: "Not found" });
}

function readToolsCache(manifestPath: string): unknown | null {
  const cachePath = path.join(path.dirname(manifestPath), "tools-cache.json");
  if (!fs.existsSync(cachePath)) {
    return null;
  }
  const raw = fs.readFileSync(cachePath, "utf-8");
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

type ToolsCache = {
  updatedAt: number;
  servers: Record<
    string,
    {
      status: "ok" | "down";
      error?: string;
      tools?: Array<{ name: string; description?: string; inputSchema?: unknown }>;
    }
  >;
};

function updateToolsCache(
  manifestPath: string,
  serverName: string,
  tools: Array<{ name: string; description?: string; inputSchema?: unknown }>,
): void {
  const cachePath = path.join(path.dirname(manifestPath), "tools-cache.json");
  const existing = readToolsCache(manifestPath) as ToolsCache | null;
  const cache: ToolsCache = existing ?? { updatedAt: Date.now(), servers: {} };
  cache.servers[serverName] = { status: "ok", tools };
  cache.updatedAt = Date.now();
  fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2));
}

function removeToolsCacheEntry(manifestPath: string, serverName: string): void {
  const cachePath = path.join(path.dirname(manifestPath), "tools-cache.json");
  const existing = readToolsCache(manifestPath) as ToolsCache | null;
  if (!existing?.servers?.[serverName]) {
    return;
  }
  delete existing.servers[serverName];
  existing.updatedAt = Date.now();
  fs.writeFileSync(cachePath, JSON.stringify(existing, null, 2));
}

function pruneToolsCache(manifestPath: string, profile: ProfileConfig): void {
  const cachePath = path.join(path.dirname(manifestPath), "tools-cache.json");
  const existing = readToolsCache(manifestPath) as ToolsCache | null;
  if (!existing?.servers) {
    return;
  }
  const allowed = new Set(profile.servers.map((server) => server.name));
  let changed = false;
  for (const name of Object.keys(existing.servers)) {
    if (!allowed.has(name)) {
      delete existing.servers[name];
      changed = true;
    }
  }
  if (changed) {
    existing.updatedAt = Date.now();
    fs.writeFileSync(cachePath, JSON.stringify(existing, null, 2));
  }
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) {
    return {};
  }
  const body = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(body);
  } catch {
    throw new Error("Invalid JSON body");
  }
}

function sendJson(res: http.ServerResponse, code: number, payload: unknown): void {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

function sendText(res: http.ServerResponse, code: number, text: string): void {
  res.statusCode = code;
  res.setHeader("Content-Type", "text/plain");
  res.end(text);
}

function serveStatic(baseDir: string, requestPath: string, res: http.ServerResponse): void {
  const normalizedPath = requestPath === "/" ? "/index.html" : requestPath;
  const safePath = path.normalize(normalizedPath).replace(/^(\.\.[/\\])+/, "");
  const fullPath = path.join(baseDir, safePath);
  if (!fullPath.startsWith(baseDir)) {
    sendText(res, 403, "Forbidden");
    return;
  }
  if (!fs.existsSync(fullPath)) {
    const indexPath = path.join(baseDir, "index.html");
    if (fs.existsSync(indexPath)) {
      sendFile(indexPath, res);
      return;
    }
    sendText(res, 404, "UI not built. Run npm run ui:build.");
    return;
  }
  sendFile(fullPath, res);
}

function sendFile(filePath: string, res: http.ServerResponse): void {
  const ext = path.extname(filePath);
  const type = mimeType(ext);
  res.statusCode = 200;
  res.setHeader("Content-Type", type);
  fs.createReadStream(filePath).pipe(res);
}

function mimeType(ext: string): string {
  switch (ext) {
    case ".html":
      return "text/html";
    case ".js":
      return "application/javascript";
    case ".css":
      return "text/css";
    case ".svg":
      return "image/svg+xml";
    case ".json":
      return "application/json";
    default:
      return "application/octet-stream";
  }
}

async function runOAuthFlow(
  server: ServerConfig,
  manifestPath: string,
  oauthCode?: string,
): Promise<void> {
  assertOAuthServerConfig(server);
  console.log(`Starting OAuth flow for ${server.name} (${server.url})`);
  const credentialStore = new CredentialStore({ manifestPath });
  const provider = new StoredOAuthProvider(credentialStore, server.auth);
  if (oauthCode) {
    const result = await auth(provider, {
      serverUrl: server.url,
      authorizationCode: oauthCode,
      scope: server.auth.scope,
    });
    console.log(`OAuth result: ${result}`);
    return;
  }
  const redirectUrl = getRedirectUrl(server);
  const codePromise = startLocalCallbackServer(redirectUrl);
  const result = await auth(provider, {
    serverUrl: server.url,
    scope: server.auth.scope,
  });
  console.log(`OAuth result: ${result}`);
  if (result === "REDIRECT") {
    const code = await codePromise;
    const finalResult = await auth(provider, {
      serverUrl: server.url,
      authorizationCode: code,
      scope: server.auth.scope,
    });
    console.log(`OAuth result: ${finalResult}`);
  }
}

function isUnauthorizedError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  if ("code" in error && (error as { code?: number }).code === 401) {
    return true;
  }
  return false;
}
