# mini-mcp

MCP server that unifies all your MCP tools without the token tax.

## Install
```
npm install
```

## Run (dev)
```
npm run dev
```

## Scripts
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

## Config UI
The server also hosts a local config UI on `http://127.0.0.1:3000`.
The UI reads and writes the SQLite DB.

Build UI once:
```
npm run ui:build
```

Run UI dev server:
```
npm run ui:dev
```

## MCP Client Config
mini-mcp runs over stdio. Configure your MCP client to launch it:
```
{
  "mcpServers": {
    "mini-mcp": {
      "command": "node",
      "args": ["./dist/index.js"],
      "env": {
        "MINI_MCP_ENCRYPTION_KEY": "your-encryption-key"
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
    "mini-mcp": {
      "command": "node",
      "args": ["./dist/index.js"],
      "env": {
        "MINI_MCP_ENCRYPTION_KEY": "your-encryption-key",
        "OPENAI_API_KEY": "sk-...",
        "MINI_MCP_OPENAI_MODEL": "gpt-5-mini"
      }
    }
  }
}
```

## LLM Summaries
Optional: auto-generate tool summaries on connect using OpenAI.
```
OPENAI_API_KEY=sk-... \
MINI_MCP_OPENAI_MODEL=gpt-5-mini \
npm run dev
```

## Local Test
```
npm install
npm run build
MINI_MCP_ENCRYPTION_KEY=your-encryption-key npx tsx scripts/stdio-test.ts
```

## Storage
mini-mcp stores configuration and tool cache in a local SQLite database.

Default DB path:
```
./mini-mcp.sqlite
```

Override with:
```
MINI_MCP_DB_PATH=/path/to/mini-mcp.sqlite
```


OAuth flow by URL/transport (manual):
```
MINI_MCP_ENCRYPTION_KEY=your-encryption-key node dist/index.js --server-url https://mcp.notion.com/mcp --transport streamableHttp
```
If the server does not exist yet, this will auto-add a default OAuth entry and use a local callback at `http://127.0.0.1:8787/callback`.
