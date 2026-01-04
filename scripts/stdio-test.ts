import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["./dist/index.js"],
  env: {
    ...process.env,
  },
});

const client = new Client(
  { name: "nimble-test", version: "0.1.0" },
  { capabilities: {} },
);

await client.connect(transport);

const tools = await client.listTools();
console.log(JSON.stringify(tools, null, 2));

await client.close();
