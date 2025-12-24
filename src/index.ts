import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

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

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: [...TOOL_DEFS] };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  if (name === "list-available-tools") {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify([]),
        },
      ],
    };
  }

  if (name === "get-tool") {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ tool: null, name: args?.name ?? null }),
        },
      ],
    };
  }

  if (name === "execute-tool") {
    return {
      content: [
        {
          type: "text",
          text: "execute-tool stub: not implemented",
        },
      ],
    };
  }

  throw new Error(`Unknown tool: ${name}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
