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
