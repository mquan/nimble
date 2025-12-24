# mini-mcp

MCP tool router that scales to thousands of tools without the token tax.

## Install
```
npm install
```

## Configure
Create a manifest at the default path or pass `--manifest` when starting the server.

Default paths:
- macOS: `~/Library/Application Support/mini-mcp/manifest.json`
- Linux: `~/.config/mini-mcp/manifest.json`

Minimal manifest example:
```
{
  "activeProfile": "default",
  "profiles": {
    "default": {
      "servers": []
    }
  }
}
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
mkdir -p "$HOME/Library/Application Support/mini-mcp"
cat > "$HOME/Library/Application Support/mini-mcp/manifest.json" <<'EOF'
{
  "activeProfile": "default",
  "profiles": {
    "default": {
      "servers": []
    }
  }
}
EOF
MINI_MCP_ENCRYPTION_KEY=your-encryption-key npx tsx scripts/stdio-test.ts
```
