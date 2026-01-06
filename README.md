# nimble

A token-efficient MCP server that lazy loads tools and proxy tool calls

## How it works
MCP clients naively include all tool descriptions and schemas on the context window. This results in excessive token consumption even when you only use a few tools. Multiply this over several MCP servers and your chat session is not only costly but also unsable as you'll quickly run into the model's token limit.

`nimble` solves the problem by allowing tools to be lazy loaded only when they're needed. The idea is connect to a unified MCP server with concise tool summaries and let LLM discover and expand full tool description when needed.

When tested with popular MCP servers (Notion, Linear, Figma, etc.), we see over 99% token savings on initial load and 90% during typical chat sessions.

<img width="437" height="277" alt="Token savings" src="https://raw.githubusercontent.com/mquan/nimble/main/images/token-savings.png" />

## Installation
nimble runs over stdio. Configure your MCP client to launch it:
```
{
  "mcpServers": {
    "nimble-mcp": {
      "command": "npx",
      "args": ["-y", "nimble-mcp"],
      "env": {
        "NIMBLE_ENCRYPTION_KEY": "your-encryption-key",
        "NIMBLE_UI_PORT": "3333"
      }
    }
  }
}
```

The `NIMBLE_ENCRYPTION_KEY` is to use to encrypt server credentials (access & refresh tokens), which are stored in local sqlite db.


Add OpenAI env vars here if you want LLM summaries to be automatically inferred when connecting a server.

Example:
```
{
  "mcpServers": {
    "nimble-mcp": {
      "command": "npx",
      "args": ["-y", "nimble-mcp"],
      "env": {
        "NIMBLE_ENCRYPTION_KEY": "your-encryption-key",
        "OPENAI_API_KEY": "sk-...",
        "OPENAI_MODEL": "gpt-5-mini"
      }
    }
  }
}
```

## Quick guide
Once configuration in your MCP client complete, open the config UI (http://localhost:3333/) in the browser to setup.

**Add a server and authenticate**

<br/>
<img width="2492" height="1502" alt="Server configs" src="https://raw.githubusercontent.com/mquan/nimble/main/images/server-config.png" />

<br/>
<br/>

If you provided an `OPENAI_API_KEY`, the summaries will be automatically inferred by LLM (OpenAI for now). Otherwise, the first sentence from the description will be used. You may also customize this by clicking on the tool and modify the summary from the tool modal

<img width="768" height="290" alt="Editing tool summary" src="https://raw.githubusercontent.com/mquan/nimble/main/images/tool-summary-edit.png" />

<br/>
<br/>

**You can also toggle tools on/off**

<img width="478" height="726" alt="Tool toggles" src="https://raw.githubusercontent.com/mquan/nimble/main/images/tool-toggle.png" />

<br/>
<br/>

**Test out the server from the included MCP client**

<img width="1451" height="851" alt="Testing with MCP client" src="https://raw.githubusercontent.com/mquan/nimble/main/images/mcp-client-test.png" />
<br/>
<br/>

Repeat the process to add more MCP servers.

## Development
Create a `.env` file in the repo root (see `.env.example`) to manage env vars locally.

```
npm run dev
```

### Scripts
Server:
```
npm run build
npm run dev
npm test
```

UI:
```
npm run ui:build
npm run ui:dev
npm run ui:preview
```

### Config UI
The server also hosts a local config UI on `http://127.0.0.1:3333`.
The UI reads and writes the SQLite DB.

Build UI once:
```
npm run ui:build
```
Or build UI + server:
```
npm run build
```

Run UI dev server:
```
npm run ui:dev
```

### LLM Summaries
Optional: auto-generate tool summaries on connect using OpenAI.
```
OPENAI_API_KEY=sk-... \
OPENAI_MODEL=gpt-5-mini \
npm run dev
```

### Storage
nimble stores configuration and tool cache in a local SQLite database.

Default DB path:
```
./nimble.sqlite
```

Override with:
```
NIMBLE_DB_PATH=/path/to/nimble.sqlite
```


OAuth flow by URL/transport (manual):
```
NIMBLE_ENCRYPTION_KEY=your-encryption-key node dist/index.js --server-url https://mcp.notion.com/mcp --transport streamableHttp
```
If the server does not exist yet, this will auto-add a default OAuth entry and use a local callback at `http://127.0.0.1:8787/callback`.

### Publish

```
npm login
npm publish --access public
```
