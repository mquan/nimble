import React, { useEffect, useMemo, useState } from "react";
import type { ServerConfig, ToolsCache } from "./types";
import {
  connectServer,
  listServers,
  loadToolsCache,
  removeServer,
  saveServer,
} from "./api";

const DEFAULT_SERVER: ServerConfig = {
  name: "",
  transport: "http",
  url: "",
  tools: { allow: ["*"] },
};

function formatUpdatedAt(value?: number) {
  if (!value) {
    return "Not yet";
  }
  return new Date(value).toLocaleString();
}

export default function App() {
  const [servers, setServers] = useState<ServerConfig[]>([]);
  const [cache, setCache] = useState<ToolsCache | null>(null);
  const [selected, setSelected] = useState<ServerConfig>(DEFAULT_SERVER);
  const [status, setStatus] = useState<string>("");
  const [isBusy, setIsBusy] = useState(false);

  const selectedIsNew = useMemo(() => {
    return !servers.find((server) => server.name === selected.name);
  }, [servers, selected.name]);

  useEffect(() => {
    void refreshAll();
  }, []);

  async function refreshAll() {
    setIsBusy(true);
    try {
      const [serverList, toolsCache] = await Promise.all([
        listServers(),
        loadToolsCache(),
      ]);
      setServers(serverList);
      setCache(toolsCache);
      if (!selected.name && serverList.length > 0) {
        setSelected(serverList[0]);
      }
    } finally {
      setIsBusy(false);
    }
  }

  async function handleSave() {
    setIsBusy(true);
    setStatus("");
    try {
      await saveServer(selected);
      setStatus("Saved server configuration.");
      await refreshAll();
    } catch (error) {
      setStatus((error as Error).message);
    } finally {
      setIsBusy(false);
    }
  }

  async function handleConnect() {
    setIsBusy(true);
    setStatus("");
    try {
      await connectServer({
        name: selected.name,
        transport: selected.transport,
        url: selected.url,
        command: selected.command,
        args: selected.args,
      });
      setStatus("Connected and discovered tools.");
      await refreshAll();
    } catch (error) {
      setStatus((error as Error).message);
    } finally {
      setIsBusy(false);
    }
  }

  async function handleRemove(name: string) {
    setIsBusy(true);
    setStatus("");
    try {
      await removeServer(name);
      setStatus("Removed server.");
      await refreshAll();
      setSelected(DEFAULT_SERVER);
    } catch (error) {
      setStatus((error as Error).message);
    } finally {
      setIsBusy(false);
    }
  }

  function updateSelected<K extends keyof ServerConfig>(
    key: K,
    value: ServerConfig[K],
  ) {
    setSelected((prev) => ({
      ...prev,
      [key]: value,
    }));
  }

  return (
    <div className="page">
      <header className="hero">
        <div>
          <p className="eyebrow">mini-mcp</p>
          <h1>
            Configure local MCP servers and browse available tools.
          </h1>
          <p className="lede">
            A lightweight control room for routing tool traffic without the
            token tax.
          </p>
        </div>
        <div className="hero-panel">
          <div>
            <p className="panel-label">Last tool sync</p>
            <p className="panel-value">{formatUpdatedAt(cache?.updatedAt)}</p>
          </div>
          <div>
            <p className="panel-label">Servers</p>
            <p className="panel-value">{servers.length}</p>
          </div>
          <div>
            <p className="panel-label">Status</p>
            <p className="panel-value">{isBusy ? "Working" : "Idle"}</p>
          </div>
        </div>
      </header>

      <main className="grid">
        <section className="card list">
          <div className="card-header">
            <h2>Servers</h2>
            <button className="ghost" onClick={refreshAll} disabled={isBusy}>
              Refresh
            </button>
          </div>
          <div className="server-list">
            {servers.map((server) => (
              <button
                key={server.name}
                className={
                  server.name === selected.name
                    ? "server-item active"
                    : "server-item"
                }
                onClick={() => setSelected(server)}
              >
                <div>
                  <p className="server-name">{server.name}</p>
                  <p className="server-meta">
                    {server.transport}
                    {server.url ? ` • ${server.url}` : ""}
                  </p>
                </div>
                <span className="badge">
                  {cache?.servers?.[server.name]?.status ?? "unknown"}
                </span>
              </button>
            ))}
            {servers.length === 0 && (
              <div className="empty">
                <p>No servers yet.</p>
                <p>Use the form to add your first server.</p>
              </div>
            )}
          </div>
        </section>

        <section className="card editor">
          <div className="card-header">
            <h2>{selectedIsNew ? "New server" : "Edit server"}</h2>
            <div className="actions">
              {!selectedIsNew && (
                <button
                  className="danger"
                  onClick={() => handleRemove(selected.name)}
                  disabled={isBusy}
                >
                  Remove
                </button>
              )}
              <button onClick={handleSave} disabled={isBusy}>
                Save
              </button>
              <button className="primary" onClick={handleConnect} disabled={isBusy}>
                Connect
              </button>
            </div>
          </div>

          <div className="form-grid">
            <label>
              Name
              <input
                value={selected.name}
                onChange={(event) => updateSelected("name", event.target.value)}
                placeholder="notion"
              />
            </label>
            <label>
              Transport
              <select
                value={selected.transport}
                onChange={(event) =>
                  updateSelected(
                    "transport",
                    event.target.value as ServerConfig["transport"],
                  )
                }
              >
                <option value="http">http (streamable)</option>
                <option value="sse">sse</option>
                <option value="stdio">stdio</option>
              </select>
            </label>
            <label className="wide">
              URL
              <input
                value={selected.url ?? ""}
                onChange={(event) => updateSelected("url", event.target.value)}
                placeholder="https://mcp.example.com/mcp"
              />
            </label>
            <label className="wide">
              Command
              <input
                value={selected.command ?? ""}
                onChange={(event) =>
                  updateSelected("command", event.target.value)
                }
                placeholder="node"
              />
            </label>
            <label className="wide">
              Args (comma separated)
              <input
                value={selected.args?.join(",") ?? ""}
                onChange={(event) =>
                  updateSelected(
                    "args",
                    event.target.value
                      .split(",")
                      .map((value) => value.trim())
                      .filter(Boolean),
                  )
                }
                placeholder="./server.js"
              />
            </label>
            <label className="wide">
              Allowlist
              <input
                value={selected.tools?.allow?.join(",") ?? "*"}
                onChange={(event) =>
                  updateSelected("tools", {
                    allow: event.target.value
                      .split(",")
                      .map((value) => value.trim())
                      .filter(Boolean),
                  })
                }
                placeholder="*"
              />
            </label>
          </div>

          {status && <p className="status">{status}</p>}
        </section>

        <section className="card tools">
          <div className="card-header">
            <h2>Tools</h2>
            <span className="subtle">From tools-cache.json</span>
          </div>
          <div className="tools-grid">
            {cache?.servers &&
              Object.entries(cache.servers).map(([name, info]) => (
                <div key={name} className="tool-group">
                  <div className="tool-group-header">
                    <div>
                      <p className="server-name">{name}</p>
                      <p className="server-meta">
                        {info.status}
                        {info.error ? ` • ${info.error}` : ""}
                      </p>
                    </div>
                    <span className="count">{info.tools?.length ?? 0}</span>
                  </div>
                  <ul>
                    {(info.tools ?? []).slice(0, 12).map((tool) => (
                      <li key={tool.name}>{tool.name}</li>
                    ))}
                    {(info.tools?.length ?? 0) > 12 && (
                      <li className="muted">
                        +{(info.tools?.length ?? 0) - 12} more
                      </li>
                    )}
                  </ul>
                </div>
              ))}
            {!cache && (
              <div className="empty">
                <p>No tool cache found yet.</p>
                <p>Connect a server to generate it.</p>
              </div>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
