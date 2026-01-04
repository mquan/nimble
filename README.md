# nimble

Unify all MCP tools under one server and save token cost.

## How it works

## Install
nimble runs over stdio. Configure your MCP client to launch it:
```
{
  "mcpServers": {
    "nimble": {
      "command": "npx",
      "args": ["-y", "nimble-mcp"],
      "env": {
        "NIMBLE_ENCRYPTION_KEY": "your-encryption-key"
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
    "nimble": {
      "command": "node",
      "args": ["-y", "nimble-mcp"],
      "env": {
        "NIMBLE_ENCRYPTION_KEY": "your-encryption-key",
        "OPENAI_API_KEY": "sk-...",
        "NIMBLE_OPENAI_MODEL": "gpt-5-mini"
      }
    }
  }
}
```

## Development
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
Or build UI + server:
```
npm run build
```

Run UI dev server:
```
npm run ui:dev
```

## LLM Summaries
Optional: auto-generate tool summaries on connect using OpenAI.
```
OPENAI_API_KEY=sk-... \
NIMBLE_OPENAI_MODEL=gpt-5-mini \
npm run dev
```

## Storage
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
