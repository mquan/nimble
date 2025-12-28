import Database from "better-sqlite3";

import type { ProfileConfig, ServerConfig } from "./config.js";

type ToolsCacheEntry = {
  status: "ok" | "down";
  error?: string;
  tools?: Array<{ name: string; description?: string; inputSchema?: unknown }>;
};

export type ToolsCache = {
  updatedAt: number;
  servers: Record<string, ToolsCacheEntry>;
};

export class ConfigStore {
  private db: Database.Database;

  constructor(private dbPath: string) {
    this.db = new Database(dbPath);
    this.ensureSchema();
  }

  close(): void {
    this.db.close();
  }

  getActiveProfileName(): string {
    const row = this.db
      .prepare("SELECT value FROM meta WHERE key = ?")
      .get("active_profile") as { value?: string } | undefined;
    const value = row?.value ?? "default";
    this.ensureProfile(value);
    return value;
  }

  setActiveProfile(name: string): void {
    this.ensureProfile(name);
    this.db
      .prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run("active_profile", name);
  }

  listServers(profileName: string): ServerConfig[] {
    this.ensureProfile(profileName);
    const rows = this.db
      .prepare(
        "SELECT name, transport, url, command, args_json, tools_allow_json, tools_aliases_json, auth_json FROM servers WHERE profile = ? ORDER BY name",
      )
      .all(profileName) as Array<{
      name: string;
      transport: ServerConfig["transport"];
      url?: string;
      command?: string;
      args_json?: string;
      tools_allow_json?: string;
      tools_aliases_json?: string;
      auth_json?: string;
    }>;

    return rows.map((row) => ({
      name: row.name,
      transport: row.transport,
      url: row.url ?? undefined,
      command: row.command ?? undefined,
      args: parseJson<string[]>(row.args_json) ?? undefined,
      tools: {
        allow: parseJson<string[]>(row.tools_allow_json) ?? ["*"],
        aliases: parseJson<Record<string, string>>(row.tools_aliases_json) ?? undefined,
      },
      auth: parseJson<ServerConfig["auth"]>(row.auth_json) ?? undefined,
    }));
  }

  upsertServer(profileName: string, server: ServerConfig): void {
    this.ensureProfile(profileName);
    const toolsAllow = server.tools?.allow ?? ["*"];
    const toolsAliases = server.tools?.aliases ?? undefined;
    const args = server.args ?? undefined;
    const auth = server.auth ?? undefined;
    this.db
      .prepare(
        "INSERT INTO servers (profile, name, transport, url, command, args_json, tools_allow_json, tools_aliases_json, auth_json, updated_at)\n" +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)\n" +
          "ON CONFLICT(profile, name) DO UPDATE SET transport = excluded.transport, url = excluded.url, command = excluded.command, args_json = excluded.args_json, tools_allow_json = excluded.tools_allow_json, tools_aliases_json = excluded.tools_aliases_json, auth_json = excluded.auth_json, updated_at = excluded.updated_at",
      )
      .run(
        profileName,
        server.name,
        server.transport,
        server.url ?? null,
        server.command ?? null,
        args ? JSON.stringify(args) : null,
        JSON.stringify(toolsAllow),
        toolsAliases ? JSON.stringify(toolsAliases) : null,
        auth ? JSON.stringify(auth) : null,
        Date.now(),
      );
  }

  deleteServer(profileName: string, name: string): void {
    this.db
      .prepare("DELETE FROM servers WHERE profile = ? AND name = ?")
      .run(profileName, name);
  }

  findServerByName(profileName: string, name: string): ServerConfig | undefined {
    return this.listServers(profileName).find((server) => server.name === name);
  }

  findServerByUrl(profileName: string, url: string): ServerConfig | undefined {
    const normalizedTarget = normalizeUrl(url);
    return this.listServers(profileName).find((server) => {
      if (!server.url) {
        return false;
      }
      const normalizedServer = normalizeUrl(server.url);
      return (
        normalizedServer === normalizedTarget ||
        normalizedServer.startsWith(normalizedTarget) ||
        normalizedTarget.startsWith(normalizedServer)
      );
    });
  }

  upsertToolsCache(
    profileName: string,
    serverName: string,
    entry: ToolsCacheEntry,
  ): void {
    this.db
      .prepare(
        "INSERT INTO tools_cache (profile, server_name, status, error, tools_json, updated_at)\n" +
          "VALUES (?, ?, ?, ?, ?, ?)\n" +
          "ON CONFLICT(profile, server_name) DO UPDATE SET status = excluded.status, error = excluded.error, tools_json = excluded.tools_json, updated_at = excluded.updated_at",
      )
      .run(
        profileName,
        serverName,
        entry.status,
        entry.error ?? null,
        entry.tools ? JSON.stringify(entry.tools) : null,
        Date.now(),
      );
  }

  removeToolsCacheEntry(profileName: string, serverName: string): void {
    this.db
      .prepare("DELETE FROM tools_cache WHERE profile = ? AND server_name = ?")
      .run(profileName, serverName);
  }

  getToolsCache(profileName: string): ToolsCache {
    const rows = this.db
      .prepare(
        "SELECT server_name, status, error, tools_json, updated_at FROM tools_cache WHERE profile = ?",
      )
      .all(profileName) as Array<{
      server_name: string;
      status: "ok" | "down";
      error?: string;
      tools_json?: string;
      updated_at: number;
    }>;
    const servers: ToolsCache["servers"] = {};
    let updatedAt = 0;
    for (const row of rows) {
      servers[row.server_name] = {
        status: row.status,
        error: row.error ?? undefined,
        tools: parseJson(row.tools_json) ?? undefined,
      };
      if (row.updated_at > updatedAt) {
        updatedAt = row.updated_at;
      }
    }
    return { updatedAt, servers };
  }

  private ensureSchema(): void {
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);\n" +
        "CREATE TABLE IF NOT EXISTS profiles (name TEXT PRIMARY KEY);\n" +
        "CREATE TABLE IF NOT EXISTS servers (\n" +
        "  profile TEXT NOT NULL,\n" +
        "  name TEXT NOT NULL,\n" +
        "  transport TEXT NOT NULL,\n" +
        "  url TEXT,\n" +
        "  command TEXT,\n" +
        "  args_json TEXT,\n" +
        "  tools_allow_json TEXT,\n" +
        "  tools_aliases_json TEXT,\n" +
        "  auth_json TEXT,\n" +
        "  updated_at INTEGER NOT NULL,\n" +
        "  PRIMARY KEY (profile, name)\n" +
        ");\n" +
        "CREATE TABLE IF NOT EXISTS tools_cache (\n" +
        "  profile TEXT NOT NULL,\n" +
        "  server_name TEXT NOT NULL,\n" +
        "  status TEXT NOT NULL,\n" +
        "  error TEXT,\n" +
        "  tools_json TEXT,\n" +
        "  updated_at INTEGER NOT NULL,\n" +
        "  PRIMARY KEY (profile, server_name)\n" +
        ");",
    );
  }

  private ensureProfile(name: string): void {
    this.db
      .prepare("INSERT OR IGNORE INTO profiles (name) VALUES (?)")
      .run(name);
  }
}

function parseJson<T>(value?: string | null): T | null {
  if (!value) {
    return null;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function normalizeUrl(value: string): string {
  return value.replace(/\/+$/, "");
}
