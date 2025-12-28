# mini-mcp

MCP tool router that scales to thousands of tools without the token tax.

## Install
```
npm install
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


OAuth flow (manual):
```
MINI_MCP_ENCRYPTION_KEY=your-encryption-key node dist/index.js --oauth-server notion
```
This prints an authorization URL. After authorizing and receiving a code:
```
MINI_MCP_ENCRYPTION_KEY=your-encryption-key node dist/index.js --oauth-server notion --oauth-code YOUR_CODE
```

OAuth flow by URL/transport (manual):
```
MINI_MCP_ENCRYPTION_KEY=your-encryption-key node dist/index.js --server-url https://mcp.notion.com/mcp --transport streamableHttp
```
If the server does not exist yet, this will auto-add a default OAuth entry and use a local callback at `http://127.0.0.1:8787/callback`.

## Credential CLI
```
MINI_MCP_ENCRYPTION_KEY=your-encryption-key node dist/index.js auth set <ref> <value>
MINI_MCP_ENCRYPTION_KEY=your-encryption-key node dist/index.js auth get <ref>
MINI_MCP_ENCRYPTION_KEY=your-encryption-key node dist/index.js auth remove <ref>
MINI_MCP_ENCRYPTION_KEY=your-encryption-key node dist/index.js auth oauth-reset <ref>
```
Stdin example:
```
echo "my-secret-token" | MINI_MCP_ENCRYPTION_KEY=your-encryption-key node dist/index.js auth set remote-token
```

## Connect CLI
```
MINI_MCP_ENCRYPTION_KEY=your-encryption-key node dist/index.js connect --name local --transport stdio --command node --args ./server.js
MINI_MCP_ENCRYPTION_KEY=your-encryption-key node dist/index.js connect --name remote --transport streamableHttp --server-url https://mcp.example.com/mcp
```
`discover` is an alias for `connect`.
Add `--db /path/to/mini-mcp.sqlite` to target a different database.

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

## Local Test
```
npm install
npm run build
MINI_MCP_ENCRYPTION_KEY=your-encryption-key npx tsx scripts/stdio-test.ts
```
