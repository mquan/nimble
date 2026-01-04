import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import path from "node:path";
import http from "node:http";
import fs from "node:fs";
import type { OAuthAuthConfig, ServerConfig, Transport } from "./config.js";
import { resolveDbPath } from "./config.js";
import { CredentialStore } from "./credentials.js";
import { StoredOAuthProvider } from "./oauth.js";
import { ToolRegistry } from "./registry.js";
import { createToolSummaryProvider } from "./summary.js";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { ConfigStore } from "./store.js";

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

const dbPath = resolveDbPath(getArgValue("--db"));
const store = new ConfigStore(dbPath);
const primaryCommand = process.argv[2];
if (primaryCommand === "auth") {
  await handleAuthCommand(dbPath);
  process.exit(0);
}
if (primaryCommand === "discover" || primaryCommand === "connect") {
  await handleConnectCommand(dbPath);
  process.exit(0);
}
const profileName = getArgValue("--profile") ?? store.getActiveProfileName();

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
  const resolvedServer = ensureOAuthServer(store, profileName, selection);
  await runOAuthFlow(resolvedServer, dbPath, oauthCode);
  process.exit(0);
}

const credentialStore = new CredentialStore({ dataDir: path.dirname(dbPath) });
const registry = new ToolRegistry(
  profileName,
  store,
  credentialStore,
  createToolSummaryProvider(),
);
await registry.initialize();

const uiPort = Number(process.env.MINI_MCP_UI_PORT ?? 3000);
startHttpServer({
  port: uiPort,
  dbPath,
  profileName,
});

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: [...TOOL_DEFS] };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  return handleMiniMcpToolCall(name, args, store, profileName, registry);
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
  store: ConfigStore,
  profileName: string,
  selection: OAuthSelection,
): ServerConfig {
  const existingByName = selection.name
    ? store.findServerByName(profileName, selection.name)
    : undefined;
  const existingByUrl = selection.url
    ? store.findServerByUrl(profileName, selection.url)
    : undefined;
  const existing = existingByName ?? existingByUrl;
  if (existing) {
    if (existing.auth?.type !== "oauth") {
      existing.auth = buildOAuthAuth(existing.name, "http://127.0.0.1:8787/callback");
    }
    if (selection.url) {
      existing.url = existing.url ?? selection.url;
    }
    existing.transport = existing.transport ?? selection.transport ?? "http";
    store.upsertServer(profileName, existing);
    return existing;
  }
  if (!selection.url) {
    const target = selection.name ?? "unknown";
    throw new Error(
      `OAuth server not found: ${target}. Add a matching server entry.`,
    );
  }
  const url = normalizeUrl(selection.url);
  const name = selection.name ?? buildServerName(url, store.listServers(profileName).map((server) => server.name));
  const transport: Transport = selection.transport ?? "http";
  const server: ServerConfig = {
    name,
    transport,
    url: selection.url,
    auth: buildOAuthAuth(name, "http://127.0.0.1:8787/callback"),
  };
  store.upsertServer(profileName, server);
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

async function handleAuthCommand(dbPath: string): Promise<void> {
  const action = process.argv[3];
  const ref = process.argv[4];
  if (!action || !ref) {
    throw new Error("Usage: mini-mcp auth <set|get|remove|oauth-reset> <ref>");
  }
  const store = new CredentialStore({ dataDir: path.dirname(dbPath) });
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

async function handleConnectCommand(dbPath: string): Promise<void> {
  const args = parseArgs(process.argv.slice(3));
  const name = args["--name"];
  const url = args["--server-url"];
  const transportArg = normalizeTransport(args["--transport"]);
  const command = args["--command"];
  const commandArgs = args["--args"]?.split(",").filter(Boolean);

  if (!name) {
    throw new Error("connect requires --name");
  }

  const result = await connectAndDiscover(dbPath, {
    name,
    transport: transportArg,
    url,
    command,
    args: commandArgs,
    profile: args["--profile"],
  });
  console.log(
    `Connected and discovered ${result.tools.length} tools for ${result.server.name}`,
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
  dbPath: string,
  input: ConnectInput,
): Promise<{ server: ServerConfig; tools: Array<{ name: string }> }> {
  const localStore = new ConfigStore(dbPath);
  const profileName = input.profile ?? localStore.getActiveProfileName();
  const existing = localStore.findServerByName(profileName, input.name);
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
    tools: existing?.tools,
    auth: existing?.auth,
  };
  if (transport === "stdio") {
    if (!server.command) {
      throw new Error("stdio connect requires --command");
    }
  } else if (!server.url) {
    throw new Error("http/sse connect requires --server-url");
  }

  const credentialStore = new CredentialStore({ dataDir: path.dirname(dbPath) });
  const registry = new ToolRegistry(
    profileName,
    localStore,
    credentialStore,
    createToolSummaryProvider(),
  );
  let tools: Array<{ name: string; description?: string; summary?: string; inputSchema?: unknown }>;
  let activeServer = server;
  try {
    tools = await registry.discoverServerTools(activeServer);
  } catch (error) {
    if (isUnauthorizedError(error)) {
      if (activeServer.auth?.type === "oauth") {
        await runOAuthFlow(activeServer, dbPath);
      } else if (
        activeServer.url &&
        (activeServer.transport === "http" || activeServer.transport === "sse")
      ) {
        const selection: OAuthSelection = {
          name: activeServer.name,
          url: activeServer.url,
          transport: activeServer.transport,
        };
        activeServer = ensureOAuthServer(localStore, profileName, selection);
        await runOAuthFlow(activeServer, dbPath);
      } else {
        throw error;
      }
      tools = await registry.discoverServerTools(activeServer);
    } else {
      throw error;
    }
  }

  const entry: ServerConfig = {
    ...activeServer,
  };
  localStore.upsertServer(profileName, entry);
  localStore.upsertToolsCache(profileName, entry.name, {
    status: "ok",
    tools,
  });
  return { server: entry, tools };
}

type HttpServerOptions = {
  port: number;
  dbPath: string;
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
        await handleApiRequest(req, res, url, options.dbPath, options.profileName);
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
  dbPath: string,
  defaultProfile: string,
): Promise<void> {
  const profileName = url.searchParams.get("profile") ?? defaultProfile;
  const localStore = new ConfigStore(dbPath);

  if (req.method === "GET" && url.pathname === "/api/servers") {
    sendJson(res, 200, { servers: localStore.listServers(profileName) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/servers") {
    const body = (await readJsonBody(req)) as ServerConfig;
    if (!body?.name || !body?.transport) {
      sendJson(res, 400, { error: "Server requires name and transport" });
      return;
    }
    localStore.upsertServer(profileName, body);
    sendJson(res, 200, { server: body });
    return;
  }

  if (req.method === "DELETE" && url.pathname.startsWith("/api/servers/")) {
    const name = decodeURIComponent(url.pathname.replace("/api/servers/", ""));
    localStore.deleteServer(profileName, name);
    localStore.removeToolsCacheEntry(profileName, name);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/connect") {
    const body = (await readJsonBody(req)) as ConnectInput;
    const result = await connectAndDiscover(dbPath, {
      ...body,
      profile: profileName,
    });
    sendJson(res, 200, { server: result.server, tools: result.tools });
    return;
  }

  if (req.method === "GET" && url.pathname.startsWith("/api/tools/")) {
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length >= 3) {
      const serverName = decodeURIComponent(parts[2] ?? "");
      const toolName = decodeURIComponent(parts[3] ?? "");
      const cache = localStore.getToolsCache(profileName);
      const tool =
        cache.servers[serverName]?.tools?.find(
          (entry) => entry.name === toolName,
        ) ?? null;
      if (!tool) {
        sendJson(res, 404, { error: "Tool not found" });
        return;
      }
      sendJson(res, 200, { tool });
      return;
    }
    sendJson(res, 400, { error: "Missing tool path" });
    return;
  }

  if (req.method === "PATCH" && url.pathname.startsWith("/api/tools/")) {
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length >= 3) {
      const serverName = decodeURIComponent(parts[2] ?? "");
      const toolName = decodeURIComponent(parts[3] ?? "");
      const body = (await readJsonBody(req)) as {
        enabled?: boolean;
        summary?: string;
      };
      const hasEnabled = typeof body.enabled === "boolean";
      const hasSummary = typeof body.summary === "string";
      if (!hasEnabled && !hasSummary) {
        sendJson(res, 400, { error: "Missing enabled or summary" });
        return;
      }
      const cache = localStore.getToolsCache(profileName);
      const entry = cache.servers[serverName];
      if (!entry?.tools) {
        sendJson(res, 404, { error: "Tool not found" });
        return;
      }
      let found = false;
      const tools = entry.tools.map((tool) => {
        if (tool.name !== toolName) {
          return tool;
        }
        found = true;
        return {
          ...tool,
          enabled: hasEnabled ? body.enabled : tool.enabled,
          summary: hasSummary ? body.summary : tool.summary,
        };
      });
      if (!found) {
        sendJson(res, 404, { error: "Tool not found" });
        return;
      }
      localStore.upsertToolsCache(profileName, serverName, {
        status: entry.status,
        error: entry.error,
        tools,
      });
      if (hasEnabled) {
        registry.setToolEnabled(serverName, toolName, body.enabled as boolean);
      }
      if (hasSummary) {
        registry.setToolSummary(serverName, toolName, body.summary as string);
      }
      sendJson(res, 200, { ok: true });
      return;
    }
    sendJson(res, 400, { error: "Missing tool path" });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/tools") {
    const cache = localStore.getToolsCache(profileName);
    sendJson(res, 200, cache);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/mcp/tools") {
    sendJson(res, 200, { tools: [...TOOL_DEFS] });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/mcp/call") {
    const body = (await readJsonBody(req)) as {
      name?: string;
      arguments?: unknown;
    };
    if (!body?.name) {
      sendJson(res, 400, { error: "Missing tool name" });
      return;
    }
    const result = await handleMiniMcpToolCall(
      body.name,
      body.arguments,
      localStore,
      profileName,
      registry,
    );
    sendJson(res, 200, { result });
    return;
  }

  sendJson(res, 404, { error: "Not found" });
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

async function handleMiniMcpToolCall(
  name: string,
  args: unknown,
  store: ConfigStore,
  profileName: string,
  registry: ToolRegistry,
) {
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
    const toolName = (args as { name?: string })?.name ?? "";
    const tool =
      registry.getTool(toolName) ??
      findToolInCache(store, profileName, toolName);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ tool, name: toolName }),
        },
      ],
    };
  }

  if (name === "execute-tool") {
    if (!args || typeof args !== "object") {
      throw new Error("execute-tool requires arguments");
    }
    const parsed = args as { name?: string; arguments?: Record<string, unknown> };
    const targetName = parsed.name ?? "";
    const toolArgs = parsed.arguments ?? {};
    const enabled = registry.getToolEnabled(targetName);
    if (enabled === false) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: `Tool disabled: ${targetName}`,
            }),
          },
        ],
      };
    }
    return registry.execute(targetName, toolArgs);
  }

  throw new Error(`Unknown tool: ${name}`);
}

async function runOAuthFlow(
  server: ServerConfig,
  dbPath: string,
  oauthCode?: string,
): Promise<void> {
  assertOAuthServerConfig(server);
  console.log(`Starting OAuth flow for ${server.name} (${server.url})`);
  const credentialStore = new CredentialStore({ dataDir: path.dirname(dbPath) });
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

function findToolInCache(
  store: ConfigStore,
  profileName: string,
  name: string,
): unknown | null {
  const cache = store.getToolsCache(profileName);
  if (name.includes("/")) {
    const [serverName, toolName] = name.split("/", 2);
    const entry = cache.servers[serverName];
    const match = entry?.tools?.find((tool) => tool.name === toolName);
    return match ?? null;
  }
  let found: unknown | null = null;
  for (const entry of Object.values(cache.servers)) {
    const match = entry.tools?.find((tool) => tool.name === name);
    if (!match) {
      continue;
    }
    if (found) {
      return null;
    }
    found = match;
  }
  return found;
}
