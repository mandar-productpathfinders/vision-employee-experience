# Vision Enterprise — Use Case 2: Employee Experience Transformation

AI-powered employee portal. Pick a life event, or talk to the agent. The agent
has tools (not a database), follows a prompt the admin can edit live, and can
gain new capabilities at runtime without a redeploy.

Demo focus: **Just Joined** event. Other events are visible in the UI and marked
"Coming soon."

---

## Architecture

```
┌──────────────────────────── Layer 3: Agent + UI ────────────────────────────┐
│  Next.js (port 3000)   ←→   Agent (port 8200)  [Anthropic | OpenAI]         │
│  • Employee Portal (left chat, right event list)                            │
│  • Admin Console (edit prompt, register tools)                              │
└─────────────────────────────────┬───────────────────────────────────────────┘
                                  │
┌─────────────────── Layer 2.5: MCP Gateway (port 8100) ──────────────────────┐
│  Express · polls admin-api every 5s · exposes /tools + /tools/call          │
└─────────────────────────────────┬───────────────────────────────────────────┘
                                  │
┌────────────────── Layer 2: FastAPI microservices ───────────────────────────┐
│  hrms-api 8101  │  onboarding-api 8102  │  access-api 8103                  │
│  documents-api 8104  │  calendar-api 8105  │  admin-api 8106                │
│  announcement-api 8107  ← backs the runtime-added tool                      │
└─────────────────────────────────┬───────────────────────────────────────────┘
                                  │
┌───────────────────────── Layer 1: Data ─────────────────────────────────────┐
│  PostgreSQL 16   ·   Redis 7 (profile cache, 5-min TTL)                     │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Quick start

```bash
cp .env.example .env
# Edit .env and set ANTHROPIC_API_KEY or OPENAI_API_KEY.
# MODEL_PROVIDER=anthropic (default) or openai

docker compose build
docker compose up -d

# Open the portal
open http://localhost:3000

# Admin console
open http://localhost:3000/admin
```

## The two demo personas

| Employee | Context | Expected behaviour |
|----------|---------|---------------------|
| **E1001 — Arjun Kumar** | New joiner (2 days in), `JUST_JOINED` active, 9 tasks pending | Agent detects new-joiner state and branches |
| **E1002 — Vishwanath Rao** | Tenured (6 years), no `JUST_JOINED` | Agent treats laptop request as standalone — no onboarding flow |

## The three demo flows

### Flow 1 — Form path (Arjun)

1. Select Arjun from the picker.
2. Click **Just Joined** on the right panel.
3. Fill the IT, HR, and Access tabs in the modal.
4. Tasks flip to `completed` in the tracker.

### Flow 2 — Chat path, new joiner asks for laptop (Arjun)

1. Arjun: "I need a laptop."
2. Agent calls `get_employee_profile`, `list_employee_events`, `list_pending_tasks`.
3. Agent: "I see you've just joined. Only the laptop is pending, or are other new-joiner tasks also open?"
4a. User: "Only laptop." → Agent asks for model and drop destination → calls `submit_it_onboarding`.
4b. User: "Multiple tasks." → Agent returns the `FORM:JUST_JOINED` token → UI opens the form modal.

### Flow 3 — Chat path, tenured asks for laptop (Vishy)

1. Switch employee to Vishy.
2. Vishy: "I need a laptop."
3. Agent sees no `JUST_JOINED` event → asks for model and drop destination directly → calls `submit_it_onboarding`. No onboarding prompts.

### Flow 4 — The admin-adds-a-tool climax

1. Open `/admin` → **Tool Registry**.
2. Click **+ Add announcement tool (demo shortcut)** — registers `send_joiner_announcement` and hot-reloads the MCP server.
3. Back on the portal, ask: *"Please send an announcement to all-engineering@visionenterprise.com introducing me to the team."*
4. The agent discovers the new tool (it arrived since the last chat turn), calls it, and confirms queued delivery.
5. Verify: `curl http://localhost:8107/announcements`

### Flow 5 — Edit the prompt live

1. Open `/admin` → **Prompt**.
2. Change a sentence (e.g., make the agent always greet in Hindi).
3. Save → version bumps.
4. Next chat turn reflects the change. No redeploy.

### Flow 6 — Switch model provider

1. Stop the agent: `docker compose stop agent`
2. Edit `.env`: `MODEL_PROVIDER=openai`
3. `docker compose up -d agent`
4. Repeat Flow 2. Same prompt, same tools, different model.

## Service ports (for direct API poking)

| Service | Port | Docs |
|---------|------|------|
| Postgres       | 5432 | — |
| Redis          | 6379 | — |
| hrms-api       | 8101 | `/docs` |
| onboarding-api | 8102 | `/docs` |
| access-api     | 8103 | `/docs` |
| documents-api  | 8104 | `/docs` |
| calendar-api   | 8105 | `/docs` |
| admin-api      | 8106 | `/docs` |
| announcement-api | 8107 | `/docs` |
| MCP server     | 8100 | `GET /health`, `GET /tools` |
| Agent          | 8200 | `POST /chat`, `GET /debug/prompt`, `GET /debug/tools` |
| Frontend       | 3000 | — |

## Smoke tests

```bash
# 1. HRMS profile with Redis cache behaviour
curl -s "http://localhost:8101/profile?employee_id=E1001" | jq
curl -s "http://localhost:8101/profile?employee_id=E1001" | jq  # _cache: hit
curl -s -X POST "http://localhost:8101/cache/invalidate?employee_id=E1001"

# 2. MCP tool registry (should show 9 system tools initially)
curl -s http://localhost:8100/tools | jq '.count'

# 3. Call a tool through MCP
curl -s -X POST http://localhost:8100/tools/call \
  -H "Content-Type: application/json" \
  -d '{"name":"get_employee_profile","input":{"employee_id":"E1001"}}' | jq

# 4. Full agent chat
curl -s -X POST http://localhost:8200/chat \
  -H "Content-Type: application/json" \
  -d '{"employee_id":"E1001","messages":[{"role":"user","content":"I need a laptop."}]}' | jq
```

## What's not included

Per the original prompt spec, data is pushed only into local submission tables.
The database-trigger or batch mechanism that would push records into downstream
applications (real HRMS, Slack, GitHub, Jira) is out of scope for this use case.
