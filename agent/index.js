/**
 * Vision Enterprise — Onboarding Agent (UC2)
 * ------------------------------------------------------------
 * A single agent, intentionally. The prompt is loaded from admin-api on every
 * turn so an admin edit takes effect on the next conversation turn with zero
 * redeploy. This is the heart of the UC2 demo.
 *
 * POST /chat
 *   body: {
 *     employee_id: string,
 *     session_id?: string,
 *     event_code?: string,            // default "JUST_JOINED"
 *     messages: [{ role, content }],  // conversation so far (user + assistant)
 *   }
 *   returns: {
 *     reply: string,              // final assistant text for display
 *     messages: [...],            // updated conversation to send back next turn
 *     trace: [...],               // tool calls with inputs/outputs/latencies
 *     model, provider,
 *     prompt_version,
 *     tool_count,
 *   }
 *
 * GET /health — liveness
 * GET /debug/prompt?event_code=JUST_JOINED — shows current prompt
 * GET /debug/tools?event_code=JUST_JOINED — shows tools MCP has
 */

import express from "express";
import cors from "cors";
import axios from "axios";
import { runTurn, toolResultMessage, activeProvider } from "./lib/provider.js";

const PORT = parseInt(process.env.PORT || "8200", 10);
const MCP_URL = process.env.MCP_SERVER_URL || "http://mcp-server:8100";
const ADMIN_URL = process.env.ADMIN_API_URL || "http://admin-api:8106";
const HRMS_URL = process.env.HRMS_API_URL || "http://hrms-api:8101";

// PII fields to redact per tool before including in trace or logs
const PII_FIELDS = {
  submit_hr_profile: ["pan_number", "bank_account", "ifsc_code", "bank_name"],
};

function maskPiiFields(toolName, input) {
  const fields = PII_FIELDS[toolName];
  if (!fields) return input;
  const masked = { ...input };
  for (const f of fields) {
    if (masked[f] !== undefined) masked[f] = "***";
  }
  return masked;
}

// Tools that must never be called directly by the agent — the frontend form handles them
const FORM_ONLY_TOOLS = ["submit_hr_profile"];

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// ---- Helpers --------------------------------------------------------------

async function loadPrompt(eventCode) {
  // Load router (dispatcher) prompt + event-specific prompt in parallel.
  // The router prompt contains the startup sequence (profile + event detection + routing).
  // The event-specific prompt contains specialist instructions for that event.
  // Both are concatenated into one system prompt so the admin can edit each independently.
  const [routerResult, eventResult] = await Promise.allSettled([
    axios.get(`${ADMIN_URL}/prompt/ROUTER`, { timeout: 3000 }),
    axios.get(`${ADMIN_URL}/prompt/${eventCode}`, { timeout: 3000 }),
  ]);

  const router = routerResult.status === "fulfilled" ? routerResult.value.data : null;
  const event  = eventResult.status  === "fulfilled" ? eventResult.value.data  : null;

  if (!router && !event) {
    throw new Error(`No prompt found for ROUTER or ${eventCode}`);
  }

  const parts = [];
  if (router) parts.push(router.prompt_text);
  if (event)  parts.push(event.prompt_text);

  return {
    prompt_text: parts.join("\n\n---\n\n"),
    version: event?.version ?? router?.version ?? 1,
  };
}

async function loadTools(eventCode) {
  const { data } = await axios.get(`${MCP_URL}/tools`, {
    params: { event_code: eventCode },
    timeout: 3000,
  });
  return data.tools || [];
}

async function callTool(name, input) {
  const started = Date.now();
  const { data } = await axios.post(
    `${MCP_URL}/tools/call`,
    { name, input },
    { timeout: 15000 }
  );
  return { ...data, client_latency_ms: Date.now() - started };
}

function injectEmployeeContext(systemPrompt, employeeId) {
  return (
    `${systemPrompt}\n\n` +
    `---\nCONTEXT\nThe employee you are helping has employee_id = "${employeeId}". ` +
    `Use this value whenever a tool requires employee_id. Do not ask the user for it.`
  );
}

// ---- Routes ---------------------------------------------------------------

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "agent", provider: activeProvider() });
});

app.get("/debug/prompt", async (req, res) => {
  try {
    const ec = req.query.event_code || "JUST_JOINED";
    res.json(await loadPrompt(ec));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/debug/tools", async (req, res) => {
  try {
    const ec = req.query.event_code || "JUST_JOINED";
    res.json({ tools: await loadTools(ec) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/chat", async (req, res) => {
  const {
    employee_id,
    session_id,
    event_code = "JUST_JOINED",
    messages = [],
  } = req.body || {};

  if (!employee_id) {
    return res.status(400).json({ error: "employee_id is required" });
  }

  let prompt, tools;
  try {
    [prompt, tools] = await Promise.all([
      loadPrompt(event_code),
      loadTools(event_code),
    ]);
  } catch (e) {
    console.error(`[agent] failed to load prompt/tools:`, e.message);
    return res
      .status(500)
      .json({ error: `failed to load prompt or tools: ${e.message}` });
  }

  const system = injectEmployeeContext(prompt.prompt_text, employee_id);

  const trace = [];
  const convo = [...messages]; // we'll append to this

  // Tool loop. Bounded to 8 turns for safety.
  const MAX_TURNS = 8;
  let finalText = "";
  let lastModel = null;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    let step;
    try {
      step = await runTurn({ system, messages: convo, tools });
    } catch (e) {
      console.error(`[agent] model call failed (turn ${turn}):`, e.message, e.status ?? "");
      return res.status(500).json({
        error: `model call failed: ${e.message}`,
        provider: activeProvider(),
      });
    }
    lastModel = step.model;
    convo.push(step.assistantMessage);

    if (step.stopReason === "end_turn" || step.toolCalls.length === 0) {
      finalText = step.text;
      break;
    }

    // Dispatch each requested tool in parallel
    const results = await Promise.all(
      step.toolCalls.map(async (tc) => {
        // Hard block: PII tools must be submitted via the secure frontend form, never via agent
        if (FORM_ONLY_TOOLS.includes(tc.name)) {
          trace.push({ turn, tool: tc.name, input: maskPiiFields(tc.name, tc.input), ok: false, latency_ms: 0, result: "Blocked: must use secure form" });
          return {
            id: tc.id,
            output: { error: `${tc.name} collects sensitive PII and must be submitted via the secure form, not through chat. Emit FORM:JJ_HR_PROFILE to open the form.` },
            isError: true,
          };
        }

        const out = await callTool(tc.name, tc.input);
        const traceEntry = {
          turn,
          tool: tc.name,
          input: maskPiiFields(tc.name, tc.input),
          ok: out.ok,
          latency_ms: out.latency_ms,
          result: out.ok ? out.result : out.error,
        };
        trace.push(traceEntry);
        // Fire-and-forget masked audit record — never blocks the response
        axios.post(`${HRMS_URL}/traces`, {
          employee_id,
          session_id,
          turn: traceEntry.turn,
          tool: traceEntry.tool,
          input: traceEntry.input,
          result: traceEntry.result,
          latency_ms: traceEntry.latency_ms,
          model: lastModel,
        }, { timeout: 3000 }).catch(() => {});
        return {
          id: tc.id,
          output: out.ok ? out.result : { error: out.error, http_status: out.http_status },
          isError: !out.ok,
        };
      })
    );

    convo.push(toolResultMessage(results));
  }

  res.json({
    reply: finalText,
    messages: convo,
    trace,
    model: lastModel,
    provider: activeProvider(),
    prompt_version: prompt.version,
    tool_count: tools.length,
  });
});

app.listen(PORT, () => {
  console.log(`[agent] listening on :${PORT}  (provider=${activeProvider()})`);
  console.log(`[agent] mcp = ${MCP_URL}, admin = ${ADMIN_URL}`);
});
