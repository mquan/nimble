import React, { useEffect, useMemo, useState } from "react";
import Prism from "prismjs";
import "prismjs/components/prism-json";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ServerConfig, ToolsCache } from "./types";
import {
  connectServer,
  listServers,
  loadMcpTools,
  loadToolDetail,
  loadToolsCache,
  callMcpTool,
  updateToolEnabled,
  updateToolSummary,
  removeServer,
  saveServer,
} from "./api";

const DEFAULT_SERVER: ServerConfig = {
  name: "",
  transport: "http",
  url: "",
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

function fenceXmlExamples(text: string) {
  const segments = text.split("```");
  return segments
    .map((segment, index) => {
      if (index % 2 === 1) {
        return segment;
      }
      return segment.replace(/<example\b[\s\S]*?<\/example>/g, (match) => {
        return `\n\`\`\`xml\n${match}\n\`\`\`\n`;
      });
    })
    .join("```");
}

type TokenCounts = { used: number; original: number };

function estimateTokens(text: string) {
  if (!text) {
    return 0;
  }
  return Math.ceil(text.length / 4);
}

function getToolSummary(description?: string) {
  if (!description) {
    return "";
  }
  const trimmed = description.trim();
  if (!trimmed) {
    return "";
  }
  const match = trimmed.match(/^.*?[.!?](\s|$)/);
  if (match) {
    return match[0].trim();
  }
  const firstLine = trimmed.split(/\r?\n/).find((line) => line.trim());
  if (!firstLine) {
    return "";
  }
  return firstLine.replace(/^#+\s*/, "").trim();
}

function resolveToolSummary(description?: string, summary?: string) {
  if (summary && summary.trim()) {
    return summary.trim();
  }
  return getToolSummary(description);
}

function getToolTokenCounts(tool: {
  name: string;
  description?: string;
  summary?: string;
  inputSchema?: unknown;
}): TokenCounts {
  const description = tool.description ?? "";
  const summary = resolveToolSummary(description, tool.summary);
  const schemaText = tool.inputSchema
    ? JSON.stringify(tool.inputSchema, null, 2)
    : "";
  const usedText = [tool.name, summary].filter(Boolean).join("\n");
  const originalText = [tool.name, description, schemaText]
    .filter(Boolean)
    .join("\n");
  return {
    used: estimateTokens(usedText),
    original: estimateTokens(originalText),
  };
}

function formatTokenMetric(counts: TokenCounts) {
  if (!counts.original) {
    return "0/0 (0%)";
  }
  const formatCompact = (value: number) => {
    if (value >= 1_000_000_000) {
      return `${(value / 1_000_000_000).toFixed(1)}B`;
    }
    if (value >= 1_000_000) {
      return `${(value / 1_000_000).toFixed(1)}M`;
    }
    if (value >= 1_000) {
      return `${(value / 1_000).toFixed(1)}K`;
    }
    return `${value}`;
  };
  const percentRaw = ((counts.original - counts.used) / counts.original) * 100;
  const percent =
    percentRaw >= 100 && counts.used > 0 ? 99.9 : Math.max(percentRaw, 0);
  return `${formatCompact(counts.used)}/${formatCompact(counts.original)} (+${percent.toFixed(1)}%)`;
}

function highlightSchemaJson(value: unknown) {
  const json = JSON.stringify(value, null, 2);
  return Prism.highlight(json, Prism.languages.json, "json");
}

function uniqueTools(
  tools: Array<{
    name: string;
    description?: string;
    summary?: string;
    enabled?: boolean;
    inputSchema?: unknown;
  }>,
) {
  const seen = new Map<string, {
    name: string;
    description?: string;
    summary?: string;
    enabled?: boolean;
    inputSchema?: unknown;
  }>();
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
  const [activeTab, setActiveTab] = useState<"config" | "client">("config");
  const [status, setStatus] = useState<{
    message: string;
    tone: "success" | "error" | "info";
  } | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [stdioJson, setStdioJson] = useState<string>("");
  const [stdioError, setStdioError] = useState<string>("");
  const [toolDetail, setToolDetail] = useState<{
    serverName: string;
    tool: {
      name: string;
      description?: string;
      summary?: string;
      enabled?: boolean;
      inputSchema?: unknown;
    };
  } | null>(null);
  const [toolLoading, setToolLoading] = useState(false);
  const [toolError, setToolError] = useState("");
  const [summaryDraft, setSummaryDraft] = useState("");
  const [summarySaving, setSummarySaving] = useState(false);
  const [mcpTools, setMcpTools] = useState<
    Array<{ name: string; description?: string; inputSchema?: unknown }>
  >([]);
  const [selectedMcpTool, setSelectedMcpTool] = useState<string>("");
  const [clientArgs, setClientArgs] = useState("");
  const [clientResult, setClientResult] = useState("");
  const [clientError, setClientError] = useState("");
  const [clientLoading, setClientLoading] = useState(false);

  const totalTools = useMemo(() => {
    if (!cache?.servers) {
      return 0;
    }
    return Object.values(cache.servers).reduce((sum, entry) => {
      return sum + uniqueTools(entry.tools ?? []).length;
    }, 0);
  }, [cache]);

  const tokenTotals = useMemo(() => {
    const perServer: Record<string, TokenCounts> = {};
    let used = 0;
    let original = 0;
    if (!cache?.servers) {
      return { perServer, overall: { used: 0, original: 0 } };
    }
    for (const [name, info] of Object.entries(cache.servers)) {
      const tools = uniqueTools(info.tools ?? []);
      const counts = tools.reduce(
        (acc, tool) => {
          const toolCounts = getToolTokenCounts(tool);
          acc.used += toolCounts.used;
          acc.original += toolCounts.original;
          return acc;
        },
        { used: 0, original: 0 },
      );
      perServer[name] = counts;
      used += counts.used;
      original += counts.original;
    }
    return { perServer, overall: { used, original } };
  }, [cache]);

  const connectedServers = useMemo(() => {
    if (!cache?.servers) {
      return 0;
    }
    return servers.reduce((sum, server) => {
      return cache.servers[server.name]?.status === "ok" ? sum + 1 : sum;
    }, 0);
  }, [cache, servers]);

  const selectedIsNew = useMemo(() => {
    return !servers.find((server) => server.name === selected.name);
  }, [servers, selected.name]);

  useEffect(() => {
    void refreshAll();
  }, []);

  useEffect(() => {
    if (activeTab !== "client") {
      return;
    }
    void refreshClientTools();
  }, [activeTab]);

  useEffect(() => {
    if (!toolDetail) {
      return;
    }
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setToolDetail(null);
      }
    };
    window.addEventListener("keydown", handler);
    return () => {
      window.removeEventListener("keydown", handler);
    };
  }, [toolDetail]);

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

  useEffect(() => {
    if (!toolDetail) {
      setSummaryDraft("");
      return;
    }
    setSummaryDraft(
      resolveToolSummary(toolDetail.tool.description, toolDetail.tool.summary),
    );
  }, [toolDetail]);

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

  async function refreshClientTools() {
    setClientLoading(true);
    setClientError("");
    try {
      const data = await loadMcpTools();
      setMcpTools(data.tools ?? []);
      if (!selectedMcpTool && data.tools?.length) {
        const first = data.tools[0]?.name ?? "";
        setSelectedMcpTool(first);
        setClientArgs(defaultClientArgs(first));
      }
    } catch (error) {
      setClientError((error as Error).message);
    } finally {
      setClientLoading(false);
    }
  }

  function defaultClientArgs(name: string) {
    if (name === "list-available-tools") {
      return "{}";
    }
    if (name === "get-tool") {
      return JSON.stringify({ name: "" }, null, 2);
    }
    if (name === "execute-tool") {
      return JSON.stringify({ name: "", arguments: {} }, null, 2);
    }
    return "{}";
  }

  function selectMcpTool(name: string) {
    setSelectedMcpTool(name);
    setClientArgs(defaultClientArgs(name));
    setClientResult("");
    setClientError("");
  }

  async function handleClientCall() {
    setClientLoading(true);
    setClientError("");
    try {
      const parsed =
        clientArgs.trim().length === 0 ? {} : (JSON.parse(clientArgs) as unknown);
      const response = await callMcpTool({
        name: selectedMcpTool,
        arguments: parsed,
      });
      setClientResult(JSON.stringify(response.result, null, 2));
    } catch (error) {
      setClientError((error as Error).message);
    } finally {
      setClientLoading(false);
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

  async function handleSummarySave() {
    if (!toolDetail) {
      return;
    }
    setSummarySaving(true);
    setToolError("");
    try {
      await updateToolSummary(
        toolDetail.serverName,
        toolDetail.tool.name,
        summaryDraft.trim(),
      );
      await refreshAll();
      const data = await loadToolDetail(
        toolDetail.serverName,
        toolDetail.tool.name,
      );
      setToolDetail({ serverName: toolDetail.serverName, tool: data.tool });
    } catch (error) {
      setToolError((error as Error).message);
    } finally {
      setSummarySaving(false);
    }
  }

  async function handleToolToggle(
    serverName: string,
    toolName: string,
    enabled: boolean,
  ) {
    setIsBusy(true);
    try {
      await updateToolEnabled(serverName, toolName, enabled);
      await refreshAll();
      if (
        toolDetail &&
        toolDetail.serverName === serverName &&
        toolDetail.tool.name === toolName
      ) {
        const data = await loadToolDetail(serverName, toolName);
        setToolDetail({ serverName, tool: data.tool });
      }
    } catch (error) {
      setStatus({ message: (error as Error).message, tone: "error" });
    } finally {
      setIsBusy(false);
    }
  }

  return (
    <div className="page">
      <header className="hero">
        <div>
          <p className="eyebrow hero-brand">nimble</p>
          <h2>
            Unify thousands of MCP tools. Save tokens.
          </h2>
        </div>
        <div className="hero-panel">
          <div>
            <p className="panel-label">Connected servers</p>
            <p className="panel-value">{connectedServers}</p>
          </div>
          <div>
            <p className="panel-label">Tools</p>
            <p className="panel-value">{totalTools}</p>
          </div>
          <div>
            <p className="panel-label">Token savings</p>
            <p className="panel-value">
              <span className="token-metric positive">
                {formatTokenMetric(tokenTotals.overall)}
              </span>
            </p>
          </div>
          <div>
            <p className="panel-label">Last tool sync</p>
            <p className="panel-value">{formatUpdatedAt(cache?.updatedAt)}</p>
          </div>
        </div>
      </header>

      <div className="tabs">
        <button
          className={activeTab === "config" ? "tab active" : "tab"}
          onClick={() => setActiveTab("config")}
        >
          Config
        </button>
        <button
          className={activeTab === "client" ? "tab active" : "tab"}
          onClick={() => setActiveTab("client")}
        >
          MCP Client
        </button>
      </div>

      {activeTab === "config" ? (
        <main className="grid">
        <p className="tab-intro">
          Configure your nimble server by connecting to MCP servers.
        </p>
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
                placeholder="MCP server"
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
              Object.entries(cache.servers).map(([name, info]) => {
                const tools = uniqueTools(info.tools ?? []);
                const toolCount = tools.length;
                const tokenMetric = tokenTotals.perServer[name] ?? { used: 0, original: 0 };
                return (
                  <div key={name} className="tool-group">
                    <div className="tool-group-header">
                      <div>
                        <p className="server-name">
                          {name} <span className="tool-count">({toolCount})</span>
                        </p>
                        <p className="server-meta">
                          {info.error ?? ""}
                        </p>
                      </div>
                      <span className="token-metric positive">
                        {formatTokenMetric(tokenMetric)}
                      </span>
                    </div>
                    <ul>
                      {tools.map((tool) => (
                        <li key={tool.name} className="tool-row">
                          <button
                            className={tool.enabled === false ? "link muted" : "link"}
                            onClick={() => openToolDetail(name, tool.name)}
                          >
                            {tool.name}
                          </button>
                          <label className="toggle">
                            <input
                              type="checkbox"
                              checked={tool.enabled !== false}
                              onChange={(event) =>
                                handleToolToggle(name, tool.name, event.target.checked)
                              }
                              onClick={(event) => event.stopPropagation()}
                              disabled={isBusy}
                            />
                            <span>Enabled</span>
                          </label>
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })}
            {!cache && (
              <div className="empty">
                <p>No tool cache found yet.</p>
                <p>Connect a server to generate it.</p>
              </div>
            )}
          </div>
        </section>

        </main>
      ) : (
        <main className="grid full">
          <p className="tab-intro">
            Test MCP tools by selecting a tool, sending JSON, and viewing the response.
          </p>
          <section className="card client">
            <div className="card-header">
              <h2>MCP Client</h2>
              <div className="actions">
                <button
                  className="ghost"
                  onClick={refreshClientTools}
                  disabled={clientLoading}
                >
                  Refresh
                </button>
              </div>
            </div>
            <div className="client-grid">
              <div className="client-list">
                <p className="panel-label">Server tools</p>
                {clientLoading && <p className="muted">Loading...</p>}
                {clientError && <p className="error">{clientError}</p>}
                {!clientLoading && !clientError && (
                  <div className="client-tools">
                    {mcpTools.map((tool) => (
                      <button
                        key={tool.name}
                        className={
                          tool.name === selectedMcpTool
                            ? "client-tool active"
                            : "client-tool"
                        }
                        onClick={() => selectMcpTool(tool.name)}
                      >
                        <p className="server-name">{tool.name}</p>
                        <p className="server-meta">{tool.description ?? ""}</p>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div className="client-panel">
                <p className="panel-label">Call tool</p>
                {selectedMcpTool ? (
                  <>
                    <label className="wide">
                      Arguments (JSON)
                      <textarea
                        value={clientArgs}
                        onChange={(event) => setClientArgs(event.target.value)}
                        rows={8}
                      />
                    </label>
                    <div className="actions">
                      <button
                        className="primary"
                        onClick={handleClientCall}
                        disabled={clientLoading}
                      >
                        Call
                      </button>
                    </div>
                    {clientError && <p className="error">{clientError}</p>}
                    {clientResult && (
                      <pre className="code-block json">
                        <code>{clientResult}</code>
                      </pre>
                    )}
                  </>
                ) : (
                  <p className="muted">Select a tool to call.</p>
                )}
              </div>
            </div>
          </section>
        </main>
      )}

      {toolDetail && (
        <div className="modal-backdrop" onClick={() => setToolDetail(null)}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <div>
                <p className="panel-label">Tool</p>
                <h3>
                  {toolDetail.tool.name}{" "}
                  <span className="token-metric positive">
                    {formatTokenMetric(getToolTokenCounts(toolDetail.tool))}
                  </span>
                </h3>
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
                <div className="modal-section">
                  <h4>Summary</h4>
                  <textarea
                    value={summaryDraft}
                    onChange={(event) => setSummaryDraft(event.target.value)}
                    rows={3}
                  />
                    <div className="actions">
                      <button
                        className="primary"
                        onClick={handleSummarySave}
                        disabled={summarySaving || toolLoading}
                      >
                        {summarySaving ? "Saving..." : "Save summary"}
                      </button>
                  </div>
                </div>
                {toolDetail.tool.description && (
                  <div className="modal-section">
                    <h4>Description</h4>
                    <div className="markdown">
                      <ReactMarkdown
                        remarkPlugins={[remarkGfm]}
                        skipHtml
                        components={{
                          pre({ children }) {
                            return <>{children}</>;
                          },
                          code({ inline, children }) {
                            if (inline) {
                              return <code>{children}</code>;
                            }
                            return (
                              <pre className="code-block">
                                <code>{children}</code>
                              </pre>
                            );
                          },
                        }}
                      >
                        {fenceXmlExamples(toolDetail.tool.description)}
                      </ReactMarkdown>
                    </div>
                  </div>
                )}
                {toolDetail.tool.inputSchema && (
                  <div className="modal-section">
                    <h4>Schema</h4>
                    <pre
                      className="code-block json"
                      dangerouslySetInnerHTML={{
                        __html: highlightSchemaJson(toolDetail.tool.inputSchema),
                      }}
                    />
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
