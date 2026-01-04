import type { ServerConfig, ToolsCache } from "./types";

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: {
      "Content-Type": "application/json",
      ...(options?.headers ?? {}),
    },
    ...options,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `Request failed: ${res.status}`);
  }
  return (await res.json()) as T;
}

export async function listServers(profile?: string): Promise<ServerConfig[]> {
  const query = profile ? `?profile=${encodeURIComponent(profile)}` : "";
  const data = await request<{ servers: ServerConfig[] }>(`/api/servers${query}`);
  return data.servers;
}

export async function saveServer(server: ServerConfig, profile?: string) {
  const query = profile ? `?profile=${encodeURIComponent(profile)}` : "";
  return request<{ server: ServerConfig }>(`/api/servers${query}`, {
    method: "POST",
    body: JSON.stringify(server),
  });
}

export async function removeServer(name: string, profile?: string) {
  const query = profile ? `?profile=${encodeURIComponent(profile)}` : "";
  return request(`/api/servers/${encodeURIComponent(name)}${query}`, {
    method: "DELETE",
  });
}

export async function connectServer(
  payload: {
    name: string;
    transport: "stdio" | "http" | "sse";
    url?: string;
    command?: string;
    args?: string[];
  },
  profile?: string,
) {
  const query = profile ? `?profile=${encodeURIComponent(profile)}` : "";
  return request(`/api/connect${query}`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function loadToolsCache(): Promise<ToolsCache | null> {
  try {
    return await request<ToolsCache>("/api/tools");
  } catch {
    return null;
  }
}

export async function loadToolDetail(
  serverName: string,
  toolName: string,
): Promise<{
  tool: {
    name: string;
    description?: string;
    summary?: string;
    enabled?: boolean;
    inputSchema?: unknown;
  };
}>{
  return request(`/api/tools/${encodeURIComponent(serverName)}/${encodeURIComponent(toolName)}`);
}

export async function updateToolEnabled(
  serverName: string,
  toolName: string,
  enabled: boolean,
): Promise<{ ok: true }> {
  return request(`/api/tools/${encodeURIComponent(serverName)}/${encodeURIComponent(toolName)}`, {
    method: "PATCH",
    body: JSON.stringify({ enabled }),
  });
}

export async function updateToolSummary(
  serverName: string,
  toolName: string,
  summary: string,
): Promise<{ ok: true }> {
  return request(`/api/tools/${encodeURIComponent(serverName)}/${encodeURIComponent(toolName)}`, {
    method: "PATCH",
    body: JSON.stringify({ summary }),
  });
}

export async function loadMcpTools(): Promise<{
  tools: Array<{ name: string; description?: string; inputSchema?: unknown }>;
}> {
  return request("/api/mcp/tools");
}

export async function callMcpTool(payload: {
  name: string;
  arguments?: unknown;
}): Promise<{ result: unknown }> {
  return request("/api/mcp/call", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}
