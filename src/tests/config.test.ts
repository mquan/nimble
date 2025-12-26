import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Manifest } from "../config.js";
import { loadManifest, saveManifest } from "../config.js";

test("loadManifest creates default manifest when missing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mini-mcp-"));
  const manifestPath = path.join(dir, "manifest.json");
  const manifest = loadManifest(manifestPath);
  assert.equal(manifest.activeProfile, "default");
  assert.deepEqual(manifest.profiles.default.servers, []);
  assert.ok(fs.existsSync(manifestPath));
});

test("saveManifest writes manifest and loadManifest reads it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mini-mcp-"));
  const manifestPath = path.join(dir, "manifest.json");
  const manifest: Manifest = {
    activeProfile: "default",
    profiles: {
      default: {
        servers: [
          {
            name: "example",
            transport: "stdio",
            command: "node",
            args: ["server.js"],
            tools: { allow: ["*"] },
          },
        ],
      },
    },
  };
  saveManifest(manifestPath, manifest);
  const loaded = loadManifest(manifestPath);
  assert.equal(loaded.activeProfile, "default");
  assert.equal(loaded.profiles.default.servers[0]?.name, "example");
});
