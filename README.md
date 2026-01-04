# nimble

Unify all MCP tools under one server and save token cost.

## How it works
MCP clients naively include all tool descriptions and schemas on the context window. This results in excessive token consumption even when you only use a few tools. Multiply this over several MCP servers and your chat session is not only costly but also unsable as you'll quickly run into the model's token limit.

`nimble` solves the problem by using concise tool summaries. Tool call is performed in two steps
1. selecting the right tool to use
2. expanding the detailed tool description and schema

We see over 99% token savings when tested with popular MCP servers (Notion, Linear, Figma, etc.)

<img width="437" height="277" alt="Token savings" src="images/token-savings.png" />

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

Add OpenAI env vars here if you want LLM summaries in this mode.
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
<img width="2492" height="1502" alt="Image" src="https://github.com/user-attachments/assets/9217ee28-4c5f-49cb-a1aa-1ae99cdfc644" />
<br/>
<br/>

If you provided an `OPENAI_API_KEY`, the summaries will be automatically inferred by LLM (OpenAI for now). Otherwise, the first sentence from the description will be used. You may also customize this by clicking on the tool and modify the summary from the tool modal

<img width="768" height="290" alt="Image" src="https://github.com/user-attachments/assets/98105d5c-5611-48fb-a324-9fa4ca58f9d8" />
<br/>
<br/>

**You can also toggle tools on/off**

<img width="478" height="726" alt="Image" src="https://github.com/user-attachments/assets/251e560e-c854-4787-8ac5-538d924388d7" />
<br/>
<br/>

**Test out the server from the included MCP client**

<img width="1451" height="851" alt="Image" src="https://github.com/user-attachments/assets/1a00ad1b-6411-4e59-8fab-5cf2a11bf541" />
<br/>
<br/>

Repeat the process to add more MCP servers.

## Development
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
