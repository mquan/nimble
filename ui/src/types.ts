export type ServerConfig = {
  name: string;
  transport: "stdio" | "http" | "sse";
  url?: string;
  command?: string;
  args?: string[];
  tools?: { aliases?: Record<string, string> };
  auth?: {
    type: "bearer" | "basic" | "apiKey" | "oauth";
    credentialRef: string;
    headerName?: string;
    queryParam?: string;
    redirectUrl?: string;
    clientMetadata?: Record<string, unknown>;
    scope?: string;
  };
};

export type ToolsCache = {
  updatedAt: number;
  servers: Record<
    string,
    {
      status: "ok" | "down";
      error?: string;
      tools?: Array<{
        name: string;
        description?: string;
        summary?: string;
        enabled?: boolean;
        inputSchema?: unknown;
      }>;
    }
  >;
};
