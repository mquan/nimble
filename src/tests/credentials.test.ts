import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CredentialStore } from "../credentials.js";

const ENV_KEY = "MINI_MCP_ENCRYPTION_KEY";

test("CredentialStore set/get roundtrip", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mini-mcp-"));
  const dataDir = path.join(dir, "data");
  const previous = process.env[ENV_KEY];
  process.env[ENV_KEY] = "test-key";

  const store = new CredentialStore({ dataDir });
  store.set("example", "secret");
  assert.equal(store.get("example"), "secret");
  store.close();

  if (previous === undefined) {
    delete process.env[ENV_KEY];
  } else {
    process.env[ENV_KEY] = previous;
  }
});

test("CredentialStore getJson handles invalid JSON", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mini-mcp-"));
  const dataDir = path.join(dir, "data");
  const previous = process.env[ENV_KEY];
  process.env[ENV_KEY] = "test-key";

  const store = new CredentialStore({ dataDir });
  store.set("bad-json", "{not-json");
  assert.equal(store.getJson("bad-json"), null);
  store.close();

  if (previous === undefined) {
    delete process.env[ENV_KEY];
  } else {
    process.env[ENV_KEY] = previous;
  }
});
