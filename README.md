# mini-mcp

MCP tool router that scales to thousands of tools without the token tax.

## Install
```
npm install
```

## Run (dev)
```
npm run dev
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
