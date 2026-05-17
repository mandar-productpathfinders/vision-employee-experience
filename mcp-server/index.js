/**
 * Vision Enterprise — MCP Server (UC2 Employee Experience)
 * ------------------------------------------------------------
 * A minimal Model Context Protocol gateway.
 *
 * Responsibilities:
 *   1. Poll admin-api every N ms for the active tool registry.
 *   2. Expose GET  /tools        — list of tools available to the agent.
 *   3. Expose POST /tools/call   — dispatch a named tool to its microservice.
 *   4. Expose POST /tools/reload — force an immediate registry reload.
 *
 * Why this layer exists:
 *   The agent does NOT talk to microservices directly. It talks to tools.
 *   Adding a tool = admin adds a row to admin_tools. Next poll, the tool is
 *   visible to the agent. No redeploy. This is the UC2 demo climax.
 */

import express from "express";
import cors from "cors";
import axios from "axios";

const PORT = parseInt(process.env.PORT || "8100", 10);
const ADMIN_API_URL = process.env.ADMIN_API_URL || "http://admin-api:8106";
const RELOAD_MS = parseInt(process.env.TOOL_RELOAD_INTERVAL_MS || "5000", 10);

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// ---- In-memory tool registry (rebuilt on each poll) -----------------------

let toolRegistry = []; // array of tool definitions from admin-api
let lastReloadAt = null;
let lastReloadError = null;

/**
 * Shape returned by admin-api /tools:
 *   { tool_name, display_name, description, input_schema,
 *     endpoint_url, http_method, event_code, is_active, is_system, updated_at }
 *
 * Shape the agent consumes (close to Anthropic/OpenAI tool schemas):
 *   { name, description, input_schema, _meta: { endpoint, method, event, system } }
 */
function normalise(tool) {
  return {
    name: tool.tool_name,
    description: tool.description,
    input_schema: tool.input_schema,
    _meta: {
      endpoint: tool.endpoint_url,
      method: (tool.http_method || "POST").toUpperCase(),
      event: tool.event_code || null,
      system: !!tool.is_system,
      display_name: tool.display_name,
      updated_at: tool.updated_at,
    },
  };
}

async function reloadRegistry() {
  try {
    const { data } = await axios.get(`${ADMIN_API_URL}/tools`, {
      params: { active_only: true },
      timeout: 3000,
    });
    toolRegistry = (data || []).map(normalise);
    lastReloadAt = new Date().toISOString();
    lastReloadError = null;
  } catch (err) {
    lastReloadError = err.message;
    console.warn(`[mcp] reload failed: ${err.message}`);
  }
}

// ---- HTTP endpoints -------------------------------------------------------

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "mcp-server",
    tools_loaded: toolRegistry.length,
    last_reload_at: lastReloadAt,
    last_reload_error: lastReloadError,
  });
});

app.get("/tools", (req, res) => {
  const event = req.query.event_code;
  let out = toolRegistry;
  if (event) {
    // Return tools scoped to the event OR global (event is null)
    out = toolRegistry.filter(
      (t) => t._meta.event === null || t._meta.event === event
    );
  }
  res.json({
    tools: out,
    count: out.length,
    loaded_at: lastReloadAt,
  });
});

app.post("/tools/reload", async (_req, res) => {
  await reloadRegistry();
  res.json({
    ok: true,
    tools_loaded: toolRegistry.length,
    loaded_at: lastReloadAt,
    error: lastReloadError,
  });
});

/**
 * Dispatch a tool.
 *
 * Body: { name: string, input: object }
 *
 * For GET tools, `input` is sent as query params. For POST/PUT, as JSON body.
 */
app.post("/tools/call", async (req, res) => {
  const started = Date.now();
  const { name, input = {} } = req.body || {};

  if (!name) {
    return res.status(400).json({ ok: false, error: "tool name required" });
  }

  const tool = toolRegistry.find((t) => t.name === name);
  if (!tool) {
    return res.status(404).json({
      ok: false,
      error: `tool '${name}' not found in active registry`,
      hint: "Did the admin just add it? Try POST /tools/reload.",
    });
  }

  const method = tool._meta.method;
  const endpoint = tool._meta.endpoint;

  try {
    const opts = { timeout: 10000 };
    let response;
    if (method === "GET") {
      response = await axios.get(endpoint, { ...opts, params: input });
    } else if (method === "DELETE") {
      response = await axios.delete(endpoint, { ...opts, params: input });
    } else {
      response = await axios({ method, url: endpoint, data: input, ...opts });
    }
    const latency = Date.now() - started;
    return res.json({
      ok: true,
      tool: name,
      latency_ms: latency,
      result: response.data,
    });
  } catch (err) {
    const latency = Date.now() - started;
    const status = err.response?.status || 500;
    const errorBody = err.response?.data || { message: err.message };
    return res.status(200).json({
      // Return 200 so the agent always gets a structured error it can reason
      // about, not a transport failure.
      ok: false,
      tool: name,
      latency_ms: latency,
      http_status: status,
      error: errorBody,
    });
  }
});

// ---- Boot -----------------------------------------------------------------

app.listen(PORT, async () => {
  console.log(`[mcp] MCP server listening on :${PORT}`);
  console.log(`[mcp] reloading tools from ${ADMIN_API_URL} every ${RELOAD_MS}ms`);
  await reloadRegistry();
  setInterval(reloadRegistry, RELOAD_MS);
});
