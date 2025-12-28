import React, { useEffect, useMemo, useState } from "react";
import type { ServerConfig, ToolsCache } from "./types";
import {
  connectServer,
  listServers,
  loadToolDetail,
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

function formatTransport(transport: ServerConfig["transport"]) {
  if (transport === "http") {
    return "streamableHTTP";
  }
  if (transport === "sse") {
    return "SSE";
  }
  return "stdio";
}

function formatStatus(status?: string) {
  if (!status) {
    return "unconnected";
  }
  if (status === "ok") {
    return "connected";
  }
  if (status === "down") {
    return "down";
  }
  return status;
}

function statusClass(status?: string) {
  const label = formatStatus(status);
  return label;
}

function uniqueTools(
  tools: Array<{ name: string; description?: string; inputSchema?: unknown }>,
) {
  const seen = new Map<string, { name: string; description?: string; inputSchema?: unknown }>();
  for (const tool of tools) {
    if (!seen.has(tool.name)) {
      seen.set(tool.name, tool);
    }
  }
  return [...seen.values()];
}
export default function App() {
  const [servers, setServers] = useState<ServerConfig[]>([]);
  const [cache, setCache] = useState<ToolsCache | null>(null);
  const [selected, setSelected] = useState<ServerConfig>(DEFAULT_SERVER);
  const [status, setStatus] = useState<{
    message: string;
    tone: "success" | "error" | "info";
  } | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [stdioJson, setStdioJson] = useState<string>("");
  const [stdioError, setStdioError] = useState<string>("");
  const [toolDetail, setToolDetail] = useState<{
    serverName: string;
    tool: { name: string; description?: string; inputSchema?: unknown };
  } | null>(null);
  const [toolLoading, setToolLoading] = useState(false);
  const [toolError, setToolError] = useState("");

  const totalTools = useMemo(() => {
    if (!cache?.servers) {
      return 0;
    }
    return Object.values(cache.servers).reduce((sum, entry) => {
      return sum + uniqueTools(entry.tools ?? []).length;
    }, 0);
  }, [cache]);

  const selectedIsNew = useMemo(() => {
    return !servers.find((server) => server.name === selected.name);
  }, [servers, selected.name]);

  useEffect(() => {
    void refreshAll();
  }, []);

  useEffect(() => {
    if (selected.transport !== "stdio") {
      setStdioJson("");
      setStdioError("");
      return;
    }
    const payload = {
      command: selected.command ?? "",
      args: selected.args ?? [],
    };
    setStdioJson(JSON.stringify(payload, null, 2));
    setStdioError("");
  }, [selected.command, selected.args, selected.transport]);

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
    setStatus(null);
    try {
      await saveServer(selected);
      setStatus({ message: "Saved server configuration.", tone: "success" });
      await refreshAll();
    } catch (error) {
      setStatus({ message: (error as Error).message, tone: "error" });
    } finally {
      setIsBusy(false);
    }
  }

  async function handleConnect() {
    setIsBusy(true);
    setStatus(null);
    try {
      await connectServer({
        name: selected.name,
        transport: selected.transport,
        url: selected.url,
        command: selected.command,
        args: selected.args,
      });
      setStatus({ message: "Connected and discovered tools.", tone: "success" });
      await refreshAll();
    } catch (error) {
      setStatus({ message: (error as Error).message, tone: "error" });
    } finally {
      setIsBusy(false);
    }
  }

  async function handleRemove(name: string) {
    setIsBusy(true);
    setStatus(null);
    try {
      await removeServer(name);
      setStatus({ message: "Removed server.", tone: "success" });
      await refreshAll();
      setSelected(DEFAULT_SERVER);
    } catch (error) {
      setStatus({ message: (error as Error).message, tone: "error" });
    } finally {
      setIsBusy(false);
    }
  }

  function handleNew() {
    setSelected({
      ...DEFAULT_SERVER,
      transport: "http",
      url: "",
      tools: { allow: ["*"] },
    });
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

  async function openToolDetail(serverName: string, toolName: string) {
    setToolLoading(true);
    setToolError("");
    try {
      const data = await loadToolDetail(serverName, toolName);
      setToolDetail({ serverName, tool: data.tool });
    } catch (error) {
      setToolError((error as Error).message);
    } finally {
      setToolLoading(false);
    }
  }

  return (
    <div className="page">
      <header className="hero">
        <div>
          <p className="eyebrow">mini-mcp</p>
          <h1>
            Unify all MCP tools in one server and save token cost
          </h1>
          <p className="lede">
            Configure mini-mcp by connecting to MCP servers.
          </p>
        </div>
        <div className="hero-panel">
          <div>
            <p className="panel-label">Servers</p>
            <p className="panel-value">{servers.length}</p>
          </div>
          <div>
            <p className="panel-label">Tools</p>
            <p className="panel-value">{totalTools}</p>
          </div>
          <div>
            <p className="panel-label">Token savings</p>
            <p className="panel-value highlight">Coming soon</p>
          </div>
          <div>
            <p className="panel-label">Last tool sync</p>
            <p className="panel-value">{formatUpdatedAt(cache?.updatedAt)}</p>
          </div>
        </div>
      </header>

      <main className="grid">
        <section className="card list">
          <div className="card-header">
            <h2>Servers</h2>
            <div className="actions">
              <button className="ghost" onClick={refreshAll} disabled={isBusy}>
                Refresh
              </button>
              <button className="primary" onClick={handleNew} disabled={isBusy}>
                New
              </button>
            </div>
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
                  <div className="server-title">
                    <p className="server-name">
                      {server.name || "Unnamed server"}
                    </p>
                    <span className="pill">{formatTransport(server.transport)}</span>
                  </div>
                  <p className="server-meta">
                    {server.url && <span className="url">{server.url}</span>}
                  </p>
                </div>
                <span className={`badge status ${statusClass(cache?.servers?.[server.name]?.status)}`}>
                  {formatStatus(cache?.servers?.[server.name]?.status)}
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
              <button className="ghost" onClick={handleSave} disabled={isBusy}>
                {selectedIsNew ? "Save" : "Update"}
              </button>
              <button className="primary" onClick={handleConnect} disabled={isBusy}>
                Connect
              </button>
            </div>
          </div>
          {!selectedIsNew && (
            <p className="hint">Editing an existing server will overwrite it on Update.</p>
          )}

          <div className="form-grid">
            <label>
              Name
              <input
                value={selected.name}
                onChange={(event) => updateSelected("name", event.target.value)}
                placeholder="notion"
              />
              <span className="hint">Server names must be unique.</span>
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
            {selected.transport !== "stdio" && (
              <label className="wide">
                URL
                <input
                  value={selected.url ?? ""}
                  onChange={(event) => updateSelected("url", event.target.value)}
                  placeholder="https://mcp.example.com/mcp"
                  disabled={!selectedIsNew}
                />
              </label>
            )}
            {selected.transport === "stdio" && (
              <label className="wide">
                Stdio config (JSON)
                <textarea
                  value={stdioJson}
                  onChange={(event) => {
                    const next = event.target.value;
                    setStdioJson(next);
                    try {
                      const parsed = JSON.parse(next) as {
                        command?: string;
                        args?: string[];
                      };
                      if (typeof parsed.command !== "string") {
                        throw new Error("command must be a string");
                      }
                      if (parsed.args && !Array.isArray(parsed.args)) {
                        throw new Error("args must be an array");
                      }
                      updateSelected("command", parsed.command);
                      updateSelected("args", parsed.args ?? []);
                      setStdioError("");
                    } catch (error) {
                      setStdioError((error as Error).message);
                    }
                  }}
                  placeholder='{"command":"node","args":["./server.js"]}'
                  rows={6}
                />
                {stdioError && <span className="error">{stdioError}</span>}
              </label>
            )}
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

          {status && (
            <p className={`status ${status.tone}`}>{status.message}</p>
          )}
        </section>

        <section className="card tools">
          <div className="card-header">
            <h2>Tools</h2>
            <span className="subtle">From local cache</span>
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
                    {uniqueTools(info.tools ?? []).slice(0, 12).map((tool) => (
                      <li key={tool.name}>
                        <button
                          className="link"
                          onClick={() => openToolDetail(name, tool.name)}
                        >
                          {tool.name}
                        </button>
                      </li>
                    ))}
                    {uniqueTools(info.tools ?? []).length > 12 && (
                      <li className="muted">
                        +{uniqueTools(info.tools ?? []).length - 12} more
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

      {toolDetail && (
        <div className="modal-backdrop" onClick={() => setToolDetail(null)}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <div>
                <p className="panel-label">Tool</p>
                <h3>{toolDetail.tool.name}</h3>
                <p className="server-meta">Server: {toolDetail.serverName}</p>
              </div>
              <button className="ghost" onClick={() => setToolDetail(null)}>
                Close
              </button>
            </div>
            {toolLoading && <p className="muted">Loading...</p>}
            {toolError && <p className="error">{toolError}</p>}
            {!toolLoading && !toolError && (
              <div className="modal-body">
                {toolDetail.tool.description && (
                  <div className="modal-section">
                    <h4>Description</h4>
                    <pre>{toolDetail.tool.description}</pre>
                  </div>
                )}
                {toolDetail.tool.inputSchema && (
                  <div className="modal-section">
                    <h4>Schema</h4>
                    <pre>
                      {JSON.stringify(toolDetail.tool.inputSchema, null, 2)}
                    </pre>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
