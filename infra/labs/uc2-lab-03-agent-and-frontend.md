# Lab 3: Agent, Admin Console, and Frontend

**Estimated time:** 50–60 minutes
**Audience:** Fresh graduates learning AI-powered enterprise applications
**Prerequisites:** Labs 1 and 2 complete — postgres, redis, seven FastAPI services, and the MCP server all running

---

## Learning Objectives

By the end of this lab you will be able to:

1. Explain the AI agentic loop: how the LLM receives a prompt, calls tools, processes results, and produces a final response
2. Articulate why Arjun and Vishy receive different responses from the same agent — even when they say the same words
3. Read an agent trace and identify the profile lookup, the event check, the tool calls, and the final response
4. Use the chat doorway and the form doorway, and explain how the agent hands off between them
5. Edit the two-tier prompt (ROUTER + JUST_JOINED) in the Admin Console and observe behavioural changes without redeploying
6. Add a new tool to the registry through the Admin Console and watch the agent use it on the next chat turn

---

## Architecture for This Lab — The Complete Picture

```
Browser  (http://localhost:3000)
        │
        │  Employee Portal              ── or ──         Admin Console (/admin)
        │  - chat input                                   - Prompt tab (Router + JUST_JOINED)
        │  - "Show form" → Modal                          - Tool Registry tab
        │  - Trace panel toggle                           - "+ Add announcement tool"
        │
        ▼
Next.js Frontend (port 3000)
        │
        │  POST /chat
        │  { employee_id, session_id, event_code,
        │    messages: [...history] }
        ▼
Agent  (Node, port 8200)
        │
        ├─── 1. loadPrompt(event_code) — fetch ROUTER + JUST_JOINED prompts
        │         GET admin-api:8106/prompt/ROUTER
        │         GET admin-api:8106/prompt/JUST_JOINED
        │         (concatenated with --- separator)
        │
        ├─── 2. loadTools(event_code) — fetch live tool catalogue
        │         GET mcp-server:8100/tools?event_code=JUST_JOINED
        │
        ├─── 3. inject employee context — append "you are helping employee_id = E1001"
        │
        ├─── 4. Anthropic API call (or OpenAI — provider abstracted)
        │         model: claude-sonnet-4-6  (default)
        │         system: [ROUTER + JUST_JOINED + context]
        │         tools: [9 or 10 tools]
        │
        │    Agent reasons (silently): "Call get_employee_profile, then
        │       list_employee_events, then list_pending_tasks. Then decide."
        │
        ├─── 5. Tool loop (up to 8 turns)
        │         each tool_use → POST mcp-server:8100/tools/call
        │                            → microservice
        │                              → PostgreSQL / Redis
        │
        ├─── 6. Final assistant text returned
        │
        └─── 7. Return { reply, messages, trace, model, provider, prompt_version, tool_count }
```

The shape of the agent is intentionally simple. Most of the behaviour lives in the prompt and the tool registry — both of which are rows in a database, not source code.

---

## Section 1: Starting the Full Stack

With everything from Labs 1 and 2 already running, start the last two services:

```bash
docker compose up -d agent frontend
```

Watch the agent boot:

```bash
docker compose logs agent | tail -5
```

You should see:
```
[agent] listening on :8200  (provider=anthropic)
[agent] mcp = http://mcp-server:8100, admin = http://admin-api:8106
```

The provider depends on which `MODEL_PROVIDER` you set in `.env`. The default is `anthropic`. To switch to OpenAI, change the env var, restart the agent container, and the same conversation will resume on the other model — same prompt, same tools, different inference engine.

Watch the frontend compile:

```bash
docker compose logs frontend -f
# Look for: "Ready in Xms" or "Compiled / route compiled"
# Press Ctrl+C to stop following
```

Open your browser: **http://localhost:3000**

You should see the Employee Portal with:
- A **persona switcher** in the top bar — Arjun (E1001), Vishy (E1002), and the two managers
- An **events panel** listing the five life-events with "demo ready" badges (only JUST_JOINED for now)
- A **tasks panel** showing the pending tasks for the selected employee
- A **chat panel** with an input box
- A **trace toggle** to show/hide the agent's reasoning

> **Windows/Turbopack note:** If the page does not update after code changes, run `docker restart ve-emp-frontend` and hard-refresh the browser (`Ctrl+Shift+R`).

---

## Section 2: The Agent — What Happens on Every Turn

Click into the chat input as Arjun (E1001) and type:

> `Hello`

While the agent thinks (3–8 seconds for the first call), let's follow what is happening in `agent/index.js`:

**1. Load the prompt (two HTTP calls in parallel)**

```javascript
const [routerResult, eventResult] = await Promise.allSettled([
  axios.get(`${ADMIN_URL}/prompt/ROUTER`),
  axios.get(`${ADMIN_URL}/prompt/JUST_JOINED`),
]);
return {
  prompt_text: [router.prompt_text, event.prompt_text].join("\n\n---\n\n"),
  version: event.version,
};
```

The agent does NOT cache the prompt. Every chat turn loads fresh from admin-api. Why? Because an administrator might have just clicked Save — and the next agent turn should reflect that change immediately.

**2. Load the tools (one HTTP call to MCP)**

```javascript
const { data } = await axios.get(`${MCP_URL}/tools`, {
  params: { event_code: "JUST_JOINED" },
});
return data.tools || [];
```

This is the live registry from `admin_tools` — nine tools by default, or ten once you have added the announcement tool. The MCP server already polled `admin-api` and built the registry; the agent just consumes it.

**3. Inject employee context**

```javascript
function injectEmployeeContext(systemPrompt, employeeId) {
  return systemPrompt +
    `\n\n---\nCONTEXT\n` +
    `The employee you are helping has employee_id = "${employeeId}". ` +
    `Use this value whenever a tool requires employee_id. Do not ask the user for it.`;
}
```

The agent does not put PII in the system prompt. The only piece of context appended is the employee_id — a foreign key the agent uses to call tools.

**4. The tool loop**

```javascript
for (let turn = 0; turn < MAX_TURNS; turn++) {  // MAX_TURNS = 8
  const step = await runTurn({ system, messages: convo, tools });
  if (step.stopReason === "end_turn") {
    finalText = step.text;
    break;
  }
  // Otherwise dispatch each tool call in parallel
  const results = await Promise.all(step.toolCalls.map(callTool));
  convo.push(toolResultMessage(results));
}
```

Each turn: the model produces either a final text response or one-or-more tool calls. Tool calls are dispatched to the MCP server in parallel; the results are appended to the conversation; the loop runs again. Capped at eight turns for safety.

**5. The return**

```javascript
res.json({
  reply: finalText,
  messages: convo,         // updated history for the next call
  trace,                   // every tool call with input, output, latency
  model: lastModel,
  provider: activeProvider(),
  prompt_version: prompt.version,
  tool_count: tools.length,
});
```

`prompt_version` shows in the chat panel footer. After an admin saves a new version, the next response shows `v2`, then `v3`, and so on.

When the response arrives, you will see Arjun greeted by name, with a brief acknowledgement of his onboarding status. Look at the footer of the chat panel — `prompt_version: 1`, `tool_count: 9` (or 10), `model: claude-sonnet-4-6`.

---

### Admin Tool
Check if the HRProfile tool is set above IT Onboarding profile. If not then using the arrows move HRProfile at the top. 

## Section 3: The Personalisation Experiment

This is the core demonstration of the lab — and it is conceptually the same demonstration as Use Case 1, with one important difference. Where UC1 personalised on **affinity data** (Priya likes ethnic wear, Rahul likes sportswear), UC2 personalises on **life-event state** (Arjun is mid-onboarding, Vishy is not).

The personalisation is not "different products for different shoppers." It is "different journeys for different intents."

### Step 1 — As Arjun, say "I need a laptop"

Make sure Arjun (E1001) is selected. Type into the chat:

> `I need a laptop`

The agent goes through its startup sequence — invisibly to the user — and responds with something like:

> *"Hi Arjun. I can see you've just joined and have a few onboarding tasks pending — nine in total across system setup, documents, and connect meetings. Is the laptop the only thing you'd like to deal with right now, or would you like to work through the other onboarding items too?"*

This is the JUST_JOINED specialist behaviour. The agent checked the life-event, saw nine pending tasks, and asked the disambiguating question before submitting the form.

### Step 2 — Reply "Only the laptop"

Reply:

> `Only the laptop`

The agent now follows up to capture the two pieces of information it needs:

> *"Got it. Do you have a preference — Mac, HP, or Dell? And where would you like it dropped — your home address, the office, or somewhere else?"*

Answer the two questions. The agent submits the IT onboarding form and confirms in one line. Look at the tasks panel — `JJ_IT_ONBOARDING` is now `completed`.

### Step 3 — Switch to Vishy and ask for the same thing

Click the persona switcher and select Vishwanath Rao (E1002). The chat clears.

Type:

> `I need a new laptop`

This time the agent's response is fundamentally different — short, direct, no mention of onboarding:

> *"Sure. Do you have a preference — Mac, HP, or Dell? And where should it be dropped?"*

Vishy is not in JUST_JOINED. The ROUTER prompt routed him to the standalone request path, not the onboarding cascade. The agent does not ask about other onboarding tasks because there are no other tasks.

### The Insight

**Same agent. Same model. Same code. Same tools. Different life-event context = different journey.**

This is the personalisation in UC2. The agent reads the state of the world (profile, events, pending tasks) before deciding what to say. The user did not need to tell the agent who they were or what context they were in. The data layer told the agent everything.

---

## Section 4: Trace Mode — Seeing the Agent Reason

Open the trace toggle in the chat panel (look for "Show trace" or a similar control). Re-send the message `I need a laptop` as Arjun. After the response arrives, the trace panel shows every step the agent took.

### Reading the Trace

For Arjun's request you should see, in order:

```
1. get_employee_profile     {employee_id: "E1001"}        14ms
   → returns full profile, manager, department, ...

2. list_employee_events     {employee_id: "E1001"}        9ms
   → returns [{event_code: "JUST_JOINED", status: "active", ...}]

3. list_pending_tasks       {employee_id: "E1001",         11ms
                             event_code: "JUST_JOINED"}
   → returns 9 tasks across SYSTEM, DOCUMENT, CONNECT

(then the agent's text response — "Hi Arjun, I see you've just joined...")
```

After Arjun's reply ("Only the laptop") and the two follow-up answers:

```
4. submit_it_onboarding     {employee_id: "E1001",         22ms
                             laptop_preference: "Mac",
                             drop_destination: "..."}
   → returns {ok: true, submission_id: ..., task_status: "completed"}
```

Notice the agent did NOT call `mark_task_complete` separately. The onboarding-api closes the task automatically. The agent saw the result and confirmed in one line.

### The Trace for Vishy

Re-send the same message as Vishy with trace on:

```
1. get_employee_profile     {employee_id: "E1002"}        12ms
2. list_employee_events     {employee_id: "E1002"}        7ms
   → returns []     ← empty array, no active events
3. submit_it_onboarding     {...}                          18ms
```

No `list_pending_tasks` call (no event = no task list to read). The agent goes directly to capturing the laptop request. **The same agent code took a different path through the tools because the data layer returned different state.**

### PII is masked in the trace

The trace is also part of the PII design. Before any tool input is written to the trace — whether it is shown in the panel, returned to the browser, or persisted — sensitive fields are redacted to `***`. If you inspect a `submit_*` entry, you will never see a PAN or bank account in the trace; the agent's `maskPiiFields()` helper replaces them first. And because `submit_hr_profile` is blocked from the chat path entirely, the most sensitive tool is one you will only ever see in the trace as a masked, blocked entry — never as a successful call carrying real data.

### The trace is now persisted (and masked)

After every tool call the agent fires a masked record at `POST /traces` on hrms-api, which writes a row to the `agent_traces` table. This is fire-and-forget, so it never slows the chat response. The masking happens before the post, so the durable audit log never contains raw PII. You can confirm it is filling up:

```bash
docker exec -it ve-emp-postgres psql -U visionuser -d vision_employee \
  -c "SELECT turn_number, tool_name, latency_ms FROM agent_traces ORDER BY id DESC LIMIT 8;"
```

### What Trace Mode is Good For

- **Debugging surprising behaviour.** "Why did the agent ask twice for the cost centre?" — look at whether `get_employee_profile` was called and what it returned.
- **Demonstrating the system to stakeholders.** A trace is more convincing than a chat transcript. It shows the agent really did look up the data.
- **Auditing.** This is the per-turn record — and it is now durable. The agent persists a masked copy of every tool call to the `agent_traces` table via `POST /traces`. (Earlier drafts described this persistence as an unbuilt exercise — "Practitioner Challenge 2" in the blog series. It is now part of the running system; the open follow-on is building a trace-viewer UI and a retention policy on top of it.)

---

## Section 5: The Two Doorways — Chat Hands Off to Form

Reset to Arjun (E1001) and start a fresh conversation. This time type:

> `I have a lot to get through today, give me everything`

The agent recognises this as a "do everything" request. Instead of asking question by question, it returns a control token:

```
FORM:JUST_JOINED
```

The token is intercepted by the frontend. The chat does NOT display it. Instead, a modal form opens with the nine pending tasks pre-organised by category.

### What the Form Doorway Looks Like

| Tab | Maps to | Fields |
|---|---|---|
| **IT** | `submit_it_onboarding` | Laptop preference, drop destination. Work number, emergency contact, and cost centre auto-populate from the HR profile. |
| **HR** | `submit_hr_profile` *(form-only — see below)* | PAN, bank name, bank account, IFSC, tax regime. The financial fields are encrypted at rest. |
| **ACCESS** | `submit_access_request` | GitHub username, Slack display name, additional tools. |

The DOCUMENT and CONNECT categories are not currently in the form modal — they remain chat-only in this release. This is a known limitation called out in CLAUDE.md as a future enhancement.

The HR tab is special. It is the **only** way the agent-driven experience collects PAN and bank details, because `submit_hr_profile` is blocked from the chat path (Lab 2, Section 5). The form posts straight to `onboarding-api`, which encrypts the financial fields before they touch the database.

Fill in any one tab and click Submit. Verify in psql:

```bash
docker exec -it ve-emp-postgres psql -U visionuser -d vision_employee \
  -c "SELECT employee_id, tax_regime, bank_name, pan_number FROM hr_profile_submissions ORDER BY id DESC LIMIT 1;"
```

You should see your submission — but note that `pan_number` comes back as an **encrypted blob**, not the value you typed. `tax_regime` and `bank_name` are readable; the financial identifiers are not. The corresponding row in `employee_task_status` is now `completed`.

### The Mechanism

The handoff between chat and form is a control token returned by the agent in plain text. The frontend's chat renderer scans every response for `FORM:<event_code>` and, when it finds one, opens the modal for that event. The chat does not display the token. To the user, the form just appeared.

This is a deliberately low-tech mechanism. It does not require a special tool, a special API, or a special UI framework. The agent's prompt has one rule: *"If the employee asks to do all tasks or has not named a specific one, return the token FORM:JUST_JOINED so the UI opens the onboarding form."* That single rule is the entire chat-to-form bridge.

### The PII doorway — when the agent refuses to take data in chat

There is a second, narrower token: `FORM:JJ_HR_PROFILE`. It exists for one reason — to keep financial identifiers out of the chat transcript and out of the model's context window.

Reset to Arjun and try typing a PAN directly into the chat, as a careless user might:

> `My PAN is ABCDE1234F, can you update my HR profile?`

The agent does **not** acknowledge or repeat the number. Its prompt carries a mandatory rule (you read it in Lab 1): never accept PAN, bank account, or IFSC in chat; instead emit `FORM:JJ_HR_PROFILE` on a line by itself. So the agent responds with something like *"For your security I won't take financial details in chat — I've opened the secure HR profile form for you,"* and the frontend intercepts the token and opens the modal **directly on the HR tab** (step 2, with `JJ_HR_PROFILE` pre-selected). The PAN you typed is never echoed back, never written to the trace in clear text, and never sent to a tool.

Two layers make this real, and you have now seen all three:

1. **Prompt (policy)** — the mandatory PII rule in the JUST_JOINED prompt (Lab 1).
2. **Agent (enforcement)** — `submit_hr_profile` is in `FORM_ONLY_TOOLS`; even if the model tried to call it, the loop blocks it and masks the trace (Lab 2).
3. **Frontend (handoff)** — the `FORM:JJ_HR_PROFILE` token opens the secure form so the data is captured and encrypted without ever transiting the LLM (this section).

Defence in depth: any one layer failing does not leak the PAN, because the next layer also has to fail.

---

## Section 6: The Admin Console — Editing the Two-Tier Prompt

Navigate to: **http://localhost:3000/admin**

You will see two top-level tabs: **Prompt** and **Tool Registry**.

Click **Prompt**. You will see two sub-tabs: **Router (Dispatcher)** and **JUST_JOINED Onboarding**.

### Why Two Prompts?

The agent on every turn loads both rows from `admin_prompts` and concatenates them with a `---` divider. The ROUTER prompt contains the startup sequence and the routing logic; the JUST_JOINED prompt contains the onboarding rules. Splitting them gives an administrator a clean editing surface — change the routing logic without touching onboarding policy, or vice versa.

### Experiment — Change Agent Tone

Click into **JUST_JOINED Onboarding**. Find the STYLE section at the bottom of the prompt. Add one line:

```
- Always begin your first reply in a conversation with the employee's first name and a brief warm welcome.
```

Click Save. The footer should briefly show "Saved · version 2".

Go back to the Employee Portal (http://localhost:3000). Make sure Arjun is selected. Start a new conversation:

> `Hello`

The response now opens with a personalised welcome. Check the chat footer: `prompt_version: 2`. The agent picked up the new version on this turn — no redeploy.

### Try the History

In psql:

```bash
docker exec -it ve-emp-postgres psql -U visionuser -d vision_employee \
  -c "SELECT event_code, version, is_active, updated_by, updated_at FROM admin_prompts WHERE event_code='JUST_JOINED' ORDER BY version DESC;"
```

You should see version 2 marked active and version 1 archived. Every save creates a new row; nothing is overwritten. This is the audit trail.

Restore the original prompt by clicking the **Revert to v1** button in the Admin Console (if present) or by clicking Save with the line removed.

### Editing the Router

The Router prompt is the harder one to edit safely. It contains the four-step startup sequence — break that and the agent stops working. Open it and read it carefully before changing anything. The rule of thumb: edit JUST_JOINED frequently; edit the ROUTER rarely, and never without a peer review.

This is why the two-tier split exists. HR and operations teams will iterate on JUST_JOINED weekly. The ROUTER is closer to infrastructure — it should change rarely and with more care.

---

## Section 7: Adding a Tool LIVE — The Demo Climax

This is the moment that distinguishes an agent platform from a workflow tool.

Click the **Tool Registry** tab in the Admin Console. You will see a table listing the nine seeded tools. Each row shows the tool name, scope, active flag, and a "system" badge (these nine cannot be deleted; only toggled off).

Scroll to the bottom. You should see a button: **+ Add announcement tool (demo shortcut)**.

Click it.

What happens behind the scenes:
1. The frontend POSTs to `admin-api:8106/tools` with a pre-built definition for `send_joiner_announcement`
2. The admin-api inserts the row into `admin_tools`
3. The frontend immediately POSTs to `mcp-server:8100/tools/reload` to force a registry refresh
4. The Tool Registry table re-renders to show the new row

You should now see **ten** rows in the table. Check the MCP server's reported count:

```bash
curl -s http://localhost:8100/health | python3 -m json.tool
# Expected: "tools_loaded": 10
```

### Use the New Tool — Through Chat

Go back to the Employee Portal (Arjun selected). Make sure most of his tasks are complete (run the form modal from Section 5 if needed — fill IT, HR, and Access). Then send:

> `Can you announce my joining to the team?`

The agent's prompt has this rule: *"If send_joiner_announcement is available and the employee has completed most tasks, offer to announce their joining. Always confirm with the employee before calling it."*

So the agent will confirm first:

> *"I can send a welcome announcement to the team about your joining. Should I go ahead?"*

Reply `yes`. The agent calls the new tool. Verify the announcement was queued:

```bash
docker exec -it ve-emp-postgres psql -U visionuser -d vision_employee \
  -c "SELECT id, employee_id, subject, status FROM announcement_queue ORDER BY id DESC LIMIT 1;"
```

You should see one queued row.

### What Just Happened — In One Sentence

You added a new capability to the agent — a capability that calls a microservice you did not deploy in this lab and a database table that was empty until ten seconds ago — and the agent used it on the next turn. **No code change. No redeploy. No restart.**

This is the centrepiece of the use case. Treat it as a hands-on demonstration of what "prompt-as-policy plus tools-as-data" means in practice.

---

## Section 8: How the Agent Loop Works (Deep Dive)

This section explains the exact message structure exchanged between the agent and the LLM. Open `agent/index.js` alongside this explanation.

### The Message History

The agent's tool loop builds a conversation history in the `convo` array, alternating between assistant turns (which may include tool calls) and user turns (which carry tool results).

**User turn — first message from the employee:**
```json
{
  "role": "user",
  "content": "I need a laptop"
}
```

**Assistant turn — agent wants to call tools:**
```json
{
  "role": "assistant",
  "content": [
    { "type": "text", "text": "" },
    {
      "type": "tool_use",
      "id": "toolu_01ABC",
      "name": "get_employee_profile",
      "input": { "employee_id": "E1001" }
    }
  ]
}
```

(In practice the agent will batch get_employee_profile, list_employee_events, and list_pending_tasks into one assistant turn with three tool_use blocks — and the MCP dispatch runs them in parallel.)

**User turn — tool results returned to the agent:**
```json
{
  "role": "user",
  "content": [
    {
      "type": "tool_result",
      "tool_use_id": "toolu_01ABC",
      "content": "{ ...profile data... }"
    }
  ]
}
```

**Assistant turn — the agent's actual reply:**
```json
{
  "role": "assistant",
  "content": [
    {
      "type": "text",
      "text": "Hi Arjun, I can see you've just joined..."
    }
  ]
}
```

### The Loop Exit Condition

```javascript
if (step.stopReason === "end_turn" || step.toolCalls.length === 0) {
  finalText = step.text;
  break;
}
```

The loop exits when the model either:
1. Says it is done (`stop_reason === "end_turn"`)
2. Returns no more tool calls

Maximum iterations: 8 (`MAX_TURNS`). If the agent somehow gets stuck calling tools in a circle, the loop terminates and returns whatever text has been generated.

### Provider Portability

The agent's `runTurn()` function lives in `agent/lib/provider.js`. It has two implementations:

```javascript
// Anthropic
async function runTurnAnthropic({ system, messages, tools }) {
  const response = await anthropic.messages.create({
    model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6",
    max_tokens: 4096,
    system,
    tools: tools.map(toAnthropicTool),
    messages,
  });
  return { ...parseAnthropicResponse(response) };
}

// OpenAI
async function runTurnOpenAI({ system, messages, tools }) {
  const response = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL || "gpt-4o",
    messages: [{ role: "system", content: system }, ...toOpenAIMessages(messages)],
    tools: tools.map(toOpenAITool),
  });
  return { ...parseOpenAIResponse(response) };
}
```

The two implementations expose the same shape — `{ assistantMessage, text, toolCalls, stopReason, model }`. The agent's loop is provider-agnostic. To switch providers, change `MODEL_PROVIDER` in `.env` and restart the agent container. The conversation, the prompt, the tools, the trace all remain identical.

### Data retention is set at the provider boundary

Both provider clients are configured so the model vendor does not retain or train on the request data — the last piece of the PII story, sitting right where data leaves your container:

```javascript
// Anthropic client — zero-data-retention beta header
new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  defaultHeaders: { "anthropic-beta": "zdr-2025-04-01" },
});

// OpenAI request — opt out of storage
openai.chat.completions.create({ model, messages, tools, store: false });
```

The Anthropic ZDR header requests zero data retention; note it must also be enabled at the organisation level (contact Anthropic support) before it takes effect in production. OpenAI's `store: false` opts each request out of storage. Together with the encryption-at-rest, the form-first PII handling, and the masked trace, this means a financial identifier that does reach the model (it should not, by design) is at least not retained by the vendor.

---

## Test Cases — Lab 3

### Browser Tests

```
T3.1 — Employee Portal loads
  Open: http://localhost:3000
  Expected: persona switcher in top bar (Arjun, Vishy, plus the two managers),
            events panel, tasks panel, chat panel

T3.2 — Arjun is in JUST_JOINED with 9 pending tasks
  Select: Arjun (E1001)
  Expected: events panel shows JUST_JOINED as active, demo-ready.
            Tasks panel shows 9 pending tasks across SYSTEM / DOCUMENT / CONNECT

T3.3 — Vishy has no active event
  Select: Vishwanath Rao (E1002)
  Expected: events panel is empty (or shows no demo-ready event)
            Tasks panel is empty

T3.4 — Chat with Arjun, request laptop only
  As Arjun: type "I need a laptop"
  Expected: agent acknowledges JUST_JOINED, names the pending task count,
            asks whether laptop is the only thing pending
  Reply "Only the laptop"
  Expected: agent asks for laptop preference and drop destination
  Reply with "Mac" and "Bengaluru office"
  Expected: agent confirms submission in one line
            Tasks panel: JJ_IT_ONBOARDING flips to completed
            Footer: prompt_version: 1, tool_count: 9 (or 10), model: claude-sonnet-4-6

T3.5 — Chat with Vishy, request laptop (standalone)
  Select: Vishwanath Rao
  Type: "I need a new laptop"
  Expected: agent asks for preference and drop destination directly
            (no mention of onboarding cascade)
  Verify the contrast with T3.4 — same words, different path

T3.6 — Chat hands off to form
  Select: Arjun (fresh — restart or wipe and reseed if his tasks are all complete)
  Type: "I have a lot to get through, give me everything"
  Expected: form modal opens with IT / HR / ACCESS tabs
            chat does NOT display the FORM:JUST_JOINED token
  Fill one tab and submit
  Expected: submission row exists in the corresponding table; task status updated

T3.7 — Trace mode shows the startup sequence
  Toggle "Show trace" on
  As Arjun: type "Hello"
  Expected: trace shows get_employee_profile, list_employee_events, list_pending_tasks
            in that order, each with latency_ms

T3.8 — Trace for Vishy lacks list_pending_tasks
  As Vishy: type "Hello"
  Expected: trace shows get_employee_profile, list_employee_events only
            (no list_pending_tasks because there is no active event)

T3.8b — PII never enters the chat (the security headline)
  As Arjun: type "My PAN is ABCDE1234F, please update my HR profile"
  Expected:
    - the agent does NOT repeat or confirm the PAN value
    - the secure HR form opens automatically on the HR tab (step 2)
    - the chat does NOT display a FORM:JJ_HR_PROFILE token
  With trace on: no submit_hr_profile call appears as a successful tool call;
    if the model attempted one it shows as a masked, blocked entry
```

### Admin Console Tests

```
T3.9 — Admin Console loads with Prompt and Tool Registry tabs
  Open: http://localhost:3000/admin
  Expected: two top-level tabs, default Prompt selected,
            Prompt tab has Router and JUST_JOINED sub-tabs

T3.10 — Read the ROUTER prompt
  Click: Prompt > Router (Dispatcher)
  Expected: text area pre-filled with the startup sequence,
            "STARTUP SEQUENCE" and "Perform the startup sequence silently"
            visible in the text

T3.11 — Edit JUST_JOINED prompt and observe version bump
  Click: Prompt > JUST_JOINED Onboarding
  Append a new line under STYLE:
    "- Always greet the employee by their first name."
  Click Save
  Expected: success message, version increments to 2

T3.12 — Prompt change takes effect on next chat turn
  Go back to Employee Portal as Arjun
  Type any message
  Expected: footer shows prompt_version: 2
            response begins with Arjun's first name
  Restore — remove the line in Admin Console and Save again
            (this creates version 3)

T3.13 — Tool Registry shows 9 system tools
  Click: Tool Registry
  Expected: table with 9 rows, each is_system = true
            "+ Add announcement tool (demo shortcut)" button visible

T3.14 — Add the announcement tool LIVE
  Click: + Add announcement tool (demo shortcut)
  Expected: row appears in the table for send_joiner_announcement
            MCP server reports tools_loaded: 10

T3.15 — Agent uses the new tool
  Back to Employee Portal as Arjun (after completing most tasks)
  Type: "Can you announce my joining to the team?"
  Expected: agent asks for confirmation
  Reply: "yes"
  Expected: agent calls send_joiner_announcement,
            announcement_queue table has a new queued row,
            chat confirms the announcement was queued
```

### API Tests

```bash
# T3.16 — Agent /chat endpoint directly
curl -s -X POST http://localhost:8200/chat \
  -H "Content-Type: application/json" \
  -d '{
    "employee_id": "E1001",
    "session_id": "lab3-sess-arjun",
    "event_code": "JUST_JOINED",
    "messages": [{"role": "user", "content": "I need a laptop"}]
  }' | python3 -m json.tool | head -40
# Expected: reply text plus trace array with at least three tool calls
#           prompt_version >= 1, tool_count >= 9, model populated

# T3.17 — Agent /debug/prompt shows current loaded prompt
curl -s "http://localhost:8200/debug/prompt?event_code=JUST_JOINED" | python3 -c "import sys,json; d=json.load(sys.stdin); print('version:', d['version']); print('prompt length:', len(d['prompt_text']))"
# Expected: version is the latest active version, prompt_text is several thousand chars

# T3.18 — Agent /debug/tools shows what MCP exposes for JUST_JOINED
curl -s "http://localhost:8200/debug/tools?event_code=JUST_JOINED" | python3 -c "import sys,json; d=json.load(sys.stdin); print('tools:', len(d['tools'])); [print(' -', t['name']) for t in d['tools']]"
# Expected: 9 or 10 tools depending on whether you ran T3.14

# T3.19 — Trace persistence IS wired, and masked
# (Run after you have exchanged a few chat turns above.)
docker exec -it ve-emp-postgres psql -U visionuser -d vision_employee \
  -c "SELECT COUNT(*) FROM agent_traces;"
# Expected: count > 0 — the agent writes a row per tool call via POST /traces
docker exec -it ve-emp-postgres psql -U visionuser -d vision_employee \
  -c "SELECT tool_name, tool_input FROM agent_traces ORDER BY id DESC LIMIT 5;"
# Expected: recent tool calls; any PII fields (pan_number, bank_account, ifsc_code)
#           appear as "***", never as real values

# T3.20 — submit_hr_profile is blocked from the agent path
curl -s -X POST http://localhost:8200/chat \
  -H "Content-Type: application/json" \
  -d '{
    "employee_id": "E1001",
    "session_id": "lab3-pii-test",
    "event_code": "JUST_JOINED",
    "messages": [{"role": "user", "content": "My PAN is ABCDE1234F and bank account 1234567890, save my HR profile"}]
  }' | python3 -m json.tool | head -50
# Expected: the reply steers the user to the secure form (emits/handles FORM:JJ_HR_PROFILE);
#           the trace shows NO successful submit_hr_profile call.
#           If the model attempted it, the entry is masked and marked blocked.

# T3.21 — Stored HR financial fields are encrypted at rest
# (Run after submitting the HR form for any employee.)
docker exec -it ve-emp-postgres psql -U visionuser -d vision_employee \
  -c "SELECT pan_number FROM hr_profile_submissions ORDER BY id DESC LIMIT 1;"
# Expected: an unreadable encrypted blob, NOT a plaintext PAN
```

All 21 tests passing means the full stack works end-to-end — including the PII controls.

---

## Key Concepts to Explain in Your Own Words

After completing this lab, try explaining these concepts without looking at your notes:

1. **Why does Arjun get a different journey than Vishy when both ask for a laptop?**
   Hint: What does the ROUTER prompt do first? What does the data layer return for each of them?

2. **What is the difference between the chat doorway and the form doorway?**
   Hint: Both call the same agent. What does the agent send back that makes the modal open?

3. **Why are the agent's prompt and the agent's tool list both stored in database tables?**
   Hint: Who needs to change them? Can they deploy code? What is the audit story?

4. **What does "the prompt is the policy" mean in practical terms?**
   Hint: When HR changes an onboarding rule, what process should follow? Whose name is on the change?

5. **What is the purpose of the two-tier prompt (ROUTER + JUST_JOINED)?**
   Hint: What changes weekly? What changes rarely? Who owns each?

6. **What would change if you switched from Anthropic to OpenAI in `.env` and restarted the agent?**
   Hint: Look at `agent/lib/provider.js`. What is the same; what is different?

7. **A user pastes their PAN into the chat. Trace the three things that stop it from leaking.**
   Hint: one rule in the prompt, one list in the agent, one token handled by the frontend — plus what happens to the value at rest and at the model boundary.

---

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| Chat returns 500 on first message | admin-api or MCP server not ready when agent first tried to load prompt/tools | Retry the message; the agent's load is per-turn |
| Footer shows `prompt_version: 0` | Prompt not found for event_code | Check `SELECT * FROM admin_prompts` — at least ROUTER and JUST_JOINED should exist |
| Agent responses are generic and ignore Arjun's onboarding state | Tool calls failing — agent has no profile/event data | Open trace; check `ok: false` rows for the failing tool |
| `tool_count: 0` in the footer | MCP server cannot reach admin-api | `curl http://localhost:8100/health` — check `last_reload_error` |
| Form modal does not open after "give me everything" | The `FORM:JUST_JOINED` token rule was removed from the prompt | Restore the rule in Admin Console under JUST_JOINED → CONVERSATION RULES |
| HR form does not open when a PAN is typed in chat | The mandatory PII rule was edited out of the JUST_JOINED prompt | Restore the "PII HANDLING RULE" line under CONVERSATION RULES (it emits `FORM:JJ_HR_PROFILE`) |
| `agent_traces` is empty | No tool calls have run yet, or hrms-api `/traces` is unreachable | Exchange a chat turn first; check `docker compose logs hrms-api` and the agent logs |
| `+ Add announcement tool` returns 409 | Tool already exists in admin_tools | `DELETE FROM admin_tools WHERE tool_name='send_joiner_announcement'` then retry |
| Anthropic 529 overloaded | API rate limited | Wait 10–20 seconds and retry; or switch provider to OpenAI |
| Prompt changes have no effect | Browser cached an old response | Hard refresh with Ctrl+Shift+R; the agent always loads fresh prompt server-side |

---

## Summary

In this lab you:

1. Started the agent and the Next.js frontend, completing the full three-layer stack
2. Watched the agent's per-turn behaviour: load two prompts, load the tool list, inject employee context, run a bounded tool loop
3. Saw the personalisation experiment — same words from Arjun (in JUST_JOINED) and Vishy (no active event) produce different journeys because the agent reads state before acting
4. Used trace mode to confirm the agent's startup sequence and see exactly which tools were called with which inputs
5. Sent a "give me everything" message and watched the chat doorway hand off to the consolidated form doorway via the FORM:JUST_JOINED control token
6. Edited the JUST_JOINED prompt in the Admin Console and observed the change land on the next turn — with a new version row in `admin_prompts`
7. Added the send_joiner_announcement tool LIVE through the Admin Console and watched the agent call it on the next chat turn — with no redeploy
8. Saw the user-facing half of the PII design end-to-end: a PAN typed into chat is refused, the secure `FORM:JJ_HR_PROFILE` form opens instead, the value is encrypted at rest, the trace is masked and persisted, and the model boundary is set to zero-data-retention

---

## What You Have Built

Across all three labs you have set up and understood a complete AI-agent-powered enterprise application:

```
Lab 1  →  Data Layer
           PostgreSQL (14 tables) + Redis (authenticated, 60s profile cache)
           Key tables: admin_prompts (policy as data) + admin_tools (capabilities as data)
           PII: pgcrypto encryption at rest on PAN/bank/IFSC

Lab 2  →  Service Layer
           7 FastAPI microservices + MCP tool gateway
           MCP polls admin_tools every 5s — adding a tool is a SQL INSERT, not a code change
           PII: submit_hr_profile blocked from the agent; masked POST /traces audit log

Lab 3  →  Agent Layer
           1 onboarding agent + Admin Console + Employee Portal
           Two-tier prompt (ROUTER + event specialist); chat AND form doorways
           Provider portability: Anthropic OR OpenAI behind one runTurn() function
           PII: chat refuses financial data → FORM:JJ_HR_PROFILE; ZDR / store:false at the model boundary
```

This is the same architectural pattern used in production internal AI applications:

- **Operational state** in a relational database with a clean per-domain microservice in front of each domain
- **Tool-calling agents** that read state before acting and write back to the same store
- **Prompts as data** so policy can be edited, versioned, and audited without code changes
- **Tool registry as data** so capabilities can be added or removed at runtime
- **Provider abstraction** so the choice of LLM is an environment decision, not a code commitment
- **Trace as audit log** for every conversation — masked and persisted to `agent_traces` after every tool call
- **PII handled in depth** — kept out of the LLM by prompt rule + agent block + form handoff, encrypted at rest, and not retained at the model boundary

The architecture and the operating model are two halves of the same investment. The labs gave you the architecture. The blog series Part 3 walks you through what the operating model needs to look like alongside it.

---

## Where to Go Next

- **The blog trilogy** for this use case — three Word documents in this folder:
  - `EmployeeExperience_Part1_AIAgentPortal.docx` — general audience
  - `EmployeeExperience_Part2_Practitioner.docx` — practitioner deep dive
  - `EmployeeExperience_Part3_LeadershipEvaluation.docx` — CIO/CPO/CDO evaluation

- **The four extension challenges** from Part 2:
  1. Add a second life-event end-to-end (PROMOTION, TRAVEL, etc.)
  2. Build a trace-viewer UI and a retention policy on top of the now-persisted `agent_traces` (the persistence itself is already done)
  3. Add a tool-level approval gate for high-risk tools
  4. Make the model provider a per-request choice

Pick one. The codebase is small enough that any of them is a weekend project — and each one tests a different muscle.
