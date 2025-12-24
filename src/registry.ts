import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import type { ProfileConfig, ServerConfig } from "./config.js";
import type { CredentialStore } from "./credentials.js";

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
};

type ToolsCache = {
  updatedAt: number;
  servers: Record<
    string,
    {
      status: "ok" | "down";
      error?: string;
      tools?: unknown[];
    }
  >;
};

export class ToolRegistry {
  private profile: ProfileConfig;
  private credentialStore: CredentialStore;
  private cachePath?: string;
  private cache: ToolsCache | null = null;
  private clients = new Map<string, Client>();
  private tools = new Map<string, ToolEntry>();
  private status = new Map<string, ServerStatus>();

  constructor(
    profile: ProfileConfig,
    credentialStore: CredentialStore,
    cachePath?: string,
  ) {
    this.profile = profile;
    this.credentialStore = credentialStore;
    this.cachePath = cachePath;
  }

  async initialize(): Promise<void> {
    this.cache = this.loadCache();
    for (const server of this.profile.servers) {
      await this.loadServer(server);
    }
    this.persistCache();
  }

  listSummaries(): { name: string; summary: string }[] {
    return [...this.tools.values()].map((entry) => ({
      name: entry.publicName,
      summary: entry.summary,
    }));
  }

  getTool(name: string): unknown | null {
    const entry = this.tools.get(name);
    return entry?.tool ?? null;
  }

  async execute(name: string, args: Record<string, unknown>) {
    const entry = this.tools.get(name);
    if (!entry) {
      throw new Error(`Tool not found: ${name}`);
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
      this.clients.set(server.name, client);
      this.status.set(server.name, { status: "ok" });
      this.registerTools(server, tools.tools ?? []);
      this.updateCache(server.name, "ok", tools.tools ?? []);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown error";
      this.status.set(server.name, { status: "down", error: message });
      this.updateCache(server.name, "down", undefined, message);
      console.error(`Server ${server.name} failed: ${message}`);
    }
  }

  private async connectClient(server: ServerConfig): Promise<Client> {
    if (server.transport !== "stdio") {
      throw new Error(`Transport not implemented: ${server.transport}`);
    }
    if (!server.command) {
      throw new Error(`Server ${server.name} is missing command`);
    }
    const transport = new StdioClientTransport({
      command: server.command,
      args: server.args ?? [],
      env: this.buildEnv(server),
    });
    const client = new Client(
      { name: "mini-mcp-client", version: "0.1.0" },
      { capabilities: {} },
    );
    await client.connect(transport);
    return client;
  }

  private buildEnv(server: ServerConfig): Record<string, string> | undefined {
    if (!server.auth) {
      return process.env as Record<string, string>;
    }
    const secret = this.credentialStore.get(server.auth.credentialRef);
    if (!secret) {
      throw new Error(`Missing credentials: ${server.auth.credentialRef}`);
    }
    if (server.auth.type === "bearer") {
      return {
        ...process.env,
        MINI_MCP_AUTH_BEARER: secret,
      };
    }
    if (server.auth.type === "basic") {
      return {
        ...process.env,
        MINI_MCP_AUTH_BASIC: secret,
      };
    }
    if (server.auth.type === "apiKey") {
      return {
        ...process.env,
        MINI_MCP_AUTH_API_KEY: secret,
      };
    }
    return process.env as Record<string, string>;
  }

  private registerTools(server: ServerConfig, tools: Array<{ name: string; description?: string; inputSchema?: unknown }>): void {
    const allow = server.tools?.allow ?? ["*"];
    const aliasMap = server.tools?.aliases ?? {};
    const aliasByTool = new Map<string, string>();
    for (const [alias, original] of Object.entries(aliasMap)) {
      aliasByTool.set(original, alias);
    }

    for (const tool of tools) {
      if (!this.isAllowed(allow, tool.name)) {
        continue;
      }
      const alias = aliasByTool.get(tool.name);
      const publicName = alias ?? `${server.name}/${tool.name}`;
      if (this.tools.has(publicName)) {
        console.error(`Tool name collision: ${publicName}`);
        continue;
      }
      this.tools.set(publicName, {
        publicName,
        summary: tool.description ?? "",
        tool,
        serverName: server.name,
        downstreamName: tool.name,
      });
    }
  }

  private isAllowed(allow: string[], toolName: string): boolean {
    if (allow.includes("*")) {
      return true;
    }
    return allow.includes(toolName);
  }

  private loadCache(): ToolsCache | null {
    if (!this.cachePath) {
      return null;
    }
    if (!fs.existsSync(this.cachePath)) {
      return { updatedAt: Date.now(), servers: {} };
    }
    const raw = fs.readFileSync(this.cachePath, "utf-8");
    try {
      const parsed = JSON.parse(raw) as ToolsCache;
      return parsed;
    } catch {
      return { updatedAt: Date.now(), servers: {} };
    }
  }

  private updateCache(
    serverName: string,
    status: "ok" | "down",
    tools?: unknown[],
    error?: string,
  ): void {
    if (!this.cache) {
      return;
    }
    this.cache.servers[serverName] = {
      status,
      error,
      tools,
    };
  }

  private persistCache(): void {
    if (!this.cache || !this.cachePath) {
      return;
    }
    this.cache.updatedAt = Date.now();
    fs.writeFileSync(this.cachePath, JSON.stringify(this.cache, null, 2));
  }
}
