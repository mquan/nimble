import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import path from "node:path";
import {
  loadManifest,
  resolveManifestPath,
  selectProfile,
} from "./config.js";
import { CredentialStore } from "./credentials.js";
import { ToolRegistry } from "./registry.js";

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

const manifestPath = resolveManifestPath(getArgValue("--manifest"));
const manifest = loadManifest(manifestPath);
const profile = selectProfile(manifest, getArgValue("--profile"));
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
