import { Buffer } from "node:buffer";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import type { ServerConfig } from "./config.js";
import type { CredentialStore } from "./credentials.js";
import { StoredOAuthProvider } from "./oauth.js";
import type { ToolSummaryProvider } from "./summary.js";
import type { ConfigStore } from "./store.js";
import type { EventSourceInit } from "eventsource";

type ServerStatus = {
  status: "ok" | "down";
  error?: string;
};

type ToolEntry = {
  publicName: string;
  summary: string;
  tool: unknown;
  serverName: string;
  downstreamName: string;
  enabled: boolean;
};

type ToolDefinition = {
  name: string;
  description?: string;
  summary?: string;
  enabled?: boolean;
  inputSchema?: unknown;
};

export class ToolRegistry {
  private profileName: string;
  private store: ConfigStore;
  private credentialStore: CredentialStore;
  private summaryProvider?: ToolSummaryProvider;
  private clients = new Map<string, Client>();
  private tools = new Map<string, ToolEntry>();
  private status = new Map<string, ServerStatus>();

  constructor(
    profileName: string,
    store: ConfigStore,
    credentialStore: CredentialStore,
    summaryProvider?: ToolSummaryProvider,
  ) {
    this.profileName = profileName;
    this.store = store;
    this.credentialStore = credentialStore;
    this.summaryProvider = summaryProvider;
  }

  async initialize(): Promise<void> {
    const servers = this.store.listServers(this.profileName);
    for (const server of servers) {
      await this.loadServer(server);
    }
  }

  async discoverServerTools(
    server: ServerConfig,
  ): Promise<ToolDefinition[]> {
    const client = await this.connectClient(server);
    const tools = await client.listTools();
    await client.close();
    const enabledByName = this.getEnabledOverrides(server.name);
    const toolDefs = await this.applyLlmSummaries(tools.tools ?? []);
    return this.enrichTools(toolDefs, enabledByName);
  }

  listSummaries(): { name: string; summary: string }[] {
    return [...this.tools.values()]
      .filter((entry) => entry.enabled)
      .map((entry) => ({
        name: entry.publicName,
        summary: entry.summary,
      }));
  }

  getTool(name: string): unknown | null {
    const entry = this.tools.get(name);
    return entry?.tool ?? null;
  }

  getToolEnabled(name: string): boolean | null {
    const entry = this.tools.get(name);
    return entry ? entry.enabled : null;
  }

  async execute(name: string, args: Record<string, unknown>) {
    const entry = this.tools.get(name);
    if (!entry) {
      throw new Error(`Tool not found: ${name}`);
    }
    if (!entry.enabled) {
      throw new Error(`Tool disabled: ${name}`);
    }
    const client = this.clients.get(entry.serverName);
    if (!client) {
      throw new Error(`Server not available: ${entry.serverName}`);
    }
    return client.callTool({
      name: entry.downstreamName,
      arguments: args,
    });
  }

  getServerStatus(): Record<string, ServerStatus> {
    const result: Record<string, ServerStatus> = {};
    for (const [name, status] of this.status.entries()) {
      result[name] = status;
    }
    return result;
  }

  private async loadServer(server: ServerConfig): Promise<void> {
    try {
      const client = await this.connectClient(server);
      const tools = await client.listTools();
      const enabledByName = this.getEnabledOverrides(server.name);
      const toolDefs = await this.applyLlmSummaries(tools.tools ?? []);
      const enrichedTools = this.enrichTools(toolDefs, enabledByName);
      this.clients.set(server.name, client);
      this.status.set(server.name, { status: "ok" });
      this.registerTools(server, enrichedTools);
      this.store.upsertToolsCache(this.profileName, server.name, {
        status: "ok",
        tools: enrichedTools,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown error";
      this.status.set(server.name, { status: "down", error: message });
      this.store.upsertToolsCache(this.profileName, server.name, {
        status: "down",
        error: message,
      });
      console.error(`Server ${server.name} failed: ${message}`);
    }
  }

  private async connectClient(server: ServerConfig): Promise<Client> {
    let transport:
      | StdioClientTransport
      | StreamableHTTPClientTransport
      | SSEClientTransport;
    if (server.transport === "stdio") {
      if (!server.command) {
        throw new Error(`Server ${server.name} is missing command`);
      }
      transport = new StdioClientTransport({
        command: server.command,
        args: server.args ?? [],
        env: this.buildEnv(server),
      });
    } else if (server.transport === "http") {
      const { url, requestInit, authProvider } = this.buildHttpConfig(server);
      transport = new StreamableHTTPClientTransport(url, {
        requestInit,
        authProvider,
      });
    } else if (server.transport === "sse") {
      const { url, requestInit, eventSourceInit, authProvider } =
        this.buildHttpConfig(server);
      transport = new SSEClientTransport(url, {
        requestInit,
        eventSourceInit,
        authProvider,
      });
    } else {
      throw new Error(`Transport not implemented: ${server.transport}`);
    }
    const client = new Client(
      { name: "nimble-client", version: "0.1.0" },
      { capabilities: {} },
    );
    await client.connect(transport);
    return client;
  }

  private buildEnv(server: ServerConfig): Record<string, string> | undefined {
    if (!server.auth) {
      return process.env as Record<string, string>;
    }
    if (server.auth.type === "oauth") {
      throw new Error(`OAuth is not supported for stdio: ${server.name}`);
    }
    const secret = this.credentialStore.get(server.auth.credentialRef);
    if (!secret) {
      throw new Error(`Missing credentials: ${server.auth.credentialRef}`);
    }
    if (server.auth.type === "bearer") {
      return {
        ...process.env,
        NIMBLE_AUTH_BEARER: secret,
      };
    }
    if (server.auth.type === "basic") {
      return {
        ...process.env,
        NIMBLE_AUTH_BASIC: secret,
      };
    }
    if (server.auth.type === "apiKey") {
      return {
        ...process.env,
        NIMBLE_AUTH_API_KEY: secret,
      };
    }
    return process.env as Record<string, string>;
  }

  private buildHttpConfig(server: ServerConfig): {
    url: URL;
    requestInit?: RequestInit;
    eventSourceInit?: EventSourceInit;
    authProvider?: StoredOAuthProvider;
  } {
    if (!server.url) {
      throw new Error(`Server ${server.name} is missing url`);
    }
    const url = new URL(server.url);
    const headers: Record<string, string> = {};
    let authProvider: StoredOAuthProvider | undefined;
    if (server.auth) {
      if (server.auth.type === "oauth") {
        authProvider = new StoredOAuthProvider(this.credentialStore, server.auth);
      } else {
        const secret = this.credentialStore.get(server.auth.credentialRef);
        if (!secret) {
          throw new Error(`Missing credentials: ${server.auth.credentialRef}`);
        }
        if (server.auth.type === "bearer") {
          headers.Authorization = `Bearer ${secret}`;
        } else if (server.auth.type === "basic") {
          const encoded = Buffer.from(secret, "utf8").toString("base64");
          headers.Authorization = `Basic ${encoded}`;
        } else if (server.auth.type === "apiKey") {
          if (server.auth.headerName) {
            headers[server.auth.headerName] = secret;
          } else if (server.auth.queryParam) {
            url.searchParams.set(server.auth.queryParam, secret);
          } else {
            headers["x-api-key"] = secret;
          }
        }
      }
    }

    const requestInit =
      Object.keys(headers).length > 0 ? { headers } : undefined;
    const eventSourceInit = this.buildEventSourceInit(headers);

    return { url, requestInit, eventSourceInit, authProvider };
  }

  private buildEventSourceInit(
    headers: Record<string, string>,
  ): EventSourceInit | undefined {
    if (Object.keys(headers).length === 0) {
      return undefined;
    }
    return {
      fetch: async (url, init) => {
        const initHeaders = normalizeHeaders(init?.headers);
        const mergedHeaders = { ...initHeaders, ...headers };
        return fetch(url, {
          ...init,
          headers: mergedHeaders,
        });
      },
    };
  }

  private registerTools(
    server: ServerConfig,
    tools: ToolDefinition[],
  ): void {
    const aliasMap = server.tools?.aliases ?? {};
    const aliasByTool = new Map<string, string>();
    for (const [alias, original] of Object.entries(aliasMap)) {
      aliasByTool.set(original, alias);
    }

    for (const tool of tools) {
      const alias = aliasByTool.get(tool.name);
      const publicName = alias ?? `${server.name}/${tool.name}`;
      if (this.tools.has(publicName)) {
        console.error(`Tool name collision: ${publicName}`);
        continue;
      }
      const enabled = tool.enabled !== false;
      this.tools.set(publicName, {
        publicName,
        summary: tool.summary ?? this.buildSummary(tool.description),
        tool: { ...tool, enabled },
        serverName: server.name,
        downstreamName: tool.name,
        enabled,
      });
    }
  }

  private enrichTools(
    tools: ToolDefinition[],
    enabledByName?: Map<string, boolean>,
  ): ToolDefinition[] {
    return tools.map((tool) => ({
      ...tool,
      summary: tool.summary ?? this.buildSummary(tool.description),
      enabled: enabledByName?.get(tool.name) ?? tool.enabled ?? true,
    }));
  }

  setToolEnabled(serverName: string, toolName: string, enabled: boolean): boolean {
    let updated = false;
    for (const entry of this.tools.values()) {
      if (entry.serverName !== serverName || entry.downstreamName !== toolName) {
        continue;
      }
      entry.enabled = enabled;
      if (entry.tool && typeof entry.tool === "object") {
        (entry.tool as { enabled?: boolean }).enabled = enabled;
      }
      updated = true;
    }
    return updated;
  }

  setToolSummary(serverName: string, toolName: string, summary: string): boolean {
    let updated = false;
    for (const entry of this.tools.values()) {
      if (entry.serverName !== serverName || entry.downstreamName !== toolName) {
        continue;
      }
      entry.summary = summary;
      if (entry.tool && typeof entry.tool === "object") {
        (entry.tool as { summary?: string }).summary = summary;
      }
      updated = true;
    }
    return updated;
  }

  private buildSummary(description?: string): string {
    if (!description) {
      return "";
    }
    const trimmed = description.trim();
    if (!trimmed) {
      return "";
    }
    const match = trimmed.match(/^.*?[.!?](\s|$)/);
    if (match) {
      return match[0].trim();
    }
    const firstLine = trimmed.split(/\r?\n/).find((line) => line.trim());
    if (!firstLine) {
      return "";
    }
    return firstLine.replace(/^#+\s*/, "").trim();
  }

  private getEnabledOverrides(serverName: string): Map<string, boolean> {
    const cache = this.store.getToolsCache(this.profileName);
    const entry = cache.servers[serverName];
    const overrides = new Map<string, boolean>();
    for (const tool of entry?.tools ?? []) {
      if (typeof tool.enabled === "boolean") {
        overrides.set(tool.name, tool.enabled);
      }
    }
    return overrides;
  }

  private async applyLlmSummaries(
    tools: ToolDefinition[],
  ): Promise<ToolDefinition[]> {
    if (!this.summaryProvider) {
      return tools;
    }
    const targets = tools
      .filter((tool) => !tool.summary && typeof tool.description === "string")
      .map((tool) => ({
        name: tool.name,
        description: (tool.description ?? "").trim(),
      }))
      .filter((tool) => tool.description.length > 0);
    if (targets.length === 0) {
      return tools;
    }
    let summaries: Record<string, string> = {};
    try {
      summaries = await this.summaryProvider.generateSummaries(targets);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error(`LLM summaries failed: ${message}`);
      return tools;
    }
    if (Object.keys(summaries).length === 0) {
      return tools;
    }
    return tools.map((tool) => {
      const summary = summaries[tool.name];
      if (!summary || tool.summary) {
        return tool;
      }
      return { ...tool, summary };
    });
  }

}

function normalizeHeaders(input?: HeadersInit): Record<string, string> {
  if (!input) {
    return {};
  }
  if (input instanceof Headers) {
    return Object.fromEntries(input.entries());
  }
  if (Array.isArray(input)) {
    return Object.fromEntries(input);
  }
  return { ...input };
}
