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

HTTP/SSE downstream example:
```
{
  "activeProfile": "default",
  "profiles": {
    "default": {
      "servers": [
        {
          "name": "remote-http",
          "transport": "http",
          "url": "http://127.0.0.1:3001/mcp",
          "tools": { "allow": ["*"] },
          "auth": {
            "type": "bearer",
            "credentialRef": "remote-token"
          }
        },
        {
          "name": "remote-sse",
          "transport": "sse",
          "url": "http://127.0.0.1:3002/mcp",
          "tools": { "allow": ["*"] }
        }
      ]
    }
  }
}
```

OAuth downstream example:
```
{
  "activeProfile": "default",
  "profiles": {
    "default": {
      "servers": [
        {
          "name": "notion",
          "transport": "http",
          "url": "https://mcp.notion.com/mcp",
          "tools": { "allow": ["*"] },
          "auth": {
            "type": "oauth",
            "credentialRef": "notion-oauth",
            "clientMetadata": {
              "client_name": "mini-mcp",
              "redirect_uris": ["http://localhost:8787/callback"],
              "grant_types": ["authorization_code", "refresh_token"],
              "response_types": ["code"],
              "token_endpoint_auth_method": "none"
            }
          }
        }
      ]
    }
  }
}
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
If the server does not exist in the manifest, this will auto-add a default OAuth entry and use a local callback at `http://127.0.0.1:8787/callback`.

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
