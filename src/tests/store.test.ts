import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ConfigStore } from "../store.js";

test("ConfigStore creates default profile and persists servers", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mini-mcp-"));
  const dbPath = path.join(dir, "mini-mcp.sqlite");
  const store = new ConfigStore(dbPath);
  const profile = store.getActiveProfileName();

  store.upsertServer(profile, {
    name: "example",
    transport: "stdio",
    command: "node",
    args: ["server.js"],
    tools: { allow: ["*"] },
  });

  const servers = store.listServers(profile);
  assert.equal(servers.length, 1);
  assert.equal(servers[0]?.name, "example");
  store.close();
});

test("ConfigStore tools cache roundtrip", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mini-mcp-"));
  const dbPath = path.join(dir, "mini-mcp.sqlite");
  const store = new ConfigStore(dbPath);
  const profile = store.getActiveProfileName();

  store.upsertToolsCache(profile, "example", {
    status: "ok",
    tools: [{ name: "tool-a" }],
  });
  const cache = store.getToolsCache(profile);
  assert.equal(cache.servers.example?.tools?.length, 1);
  store.close();
});
