# CLAUDE.md — Vision Enterprise UC2: Employee Experience Transformation
## Codebase handoff + known issues + fix instructions

**Prepared by:** Claude (Anthropic)
**Status:** App built, syntax-checked, zipped and delivered. Not yet docker-run-verified (no Docker in build sandbox). Scripts and labs not yet started.

---

## 1. What was built

A full three-layer AI-powered Employee Portal for the "Just Joined" onboarding use case.

### Stack (mirrors UC1 exactly)
| Layer | Technology | Purpose |
|---|---|---|
| Data | PostgreSQL 16 + Redis 7 | Relational storage + profile cache |
| Services | 7 × FastAPI (Python 3.12) | One microservice per domain |
| MCP Gateway | Express.js (Node 20) | Tool registry, hot-reload, dispatch |
| Agent | Node 20 | Onboarding agent, prompt loaded at runtime |
| Frontend | Next.js 14 (TypeScript) | Employee Portal + Admin Console |

### Ports
| Service | Port |
|---|---|
| PostgreSQL | 5432 |
| Redis | 6379 |
| hrms-api | 8101 |
| onboarding-api | 8102 |
| access-api | 8103 |
| documents-api | 8104 |
| calendar-api | 8105 |
| admin-api | 8106 |
| announcement-api | 8107 |
| mcp-server | 8100 |
| agent | 8200 |
| frontend (Next.js) | 3000 |

---

## 2. Full directory tree

```
vision-employee-experience/
├── docker-compose.yml
├── .env.example
├── .gitignore
├── README.md
│
├── infra/
│   └── db/
│       ├── schema.sql        (205 lines — 12 tables, 10 indexes)
│       └── seed.sql          (176 lines — events, tasks, 2 employees, prompt, 9 tools)
│
├── services/
│   ├── hrms-api/             (port 8101)
│   │   ├── Dockerfile
│   │   ├── requirements.txt
│   │   └── app/
│   │       ├── __init__.py
│   │       ├── db.py         (shared Postgres + Redis helpers)
│   │       └── main.py       (177 lines)
│   ├── onboarding-api/       (port 8102)
│   │   └── app/main.py       (136 lines)
│   ├── access-api/           (port 8103)
│   │   └── app/main.py       (73 lines)
│   ├── documents-api/        (port 8104)
│   │   └── app/main.py       (66 lines)
│   ├── calendar-api/         (port 8105)
│   │   └── app/main.py       (140 lines)
│   ├── admin-api/            (port 8106)
│   │   └── app/main.py       (244 lines)
│   └── announcement-api/     (port 8107)
│       └── app/main.py       (76 lines)
│
├── mcp-server/               (port 8100)
│   ├── Dockerfile
│   ├── package.json
│   └── index.js              (180 lines)
│
├── agent/                    (port 8200)
│   ├── Dockerfile
│   ├── package.json
│   ├── index.js              (190 lines)
│   └── lib/
│       └── provider.js       (222 lines — Anthropic + OpenAI abstraction)
│
└── frontend/                 (port 3000)
    ├── Dockerfile
    ├── package.json
    ├── next.config.js
    ├── tsconfig.json
    └── app/
        ├── layout.tsx         (26 lines — topbar, Portal/Admin nav)
        ├── globals.css        (125 lines — design tokens, components)
        ├── page.tsx           (867 lines — Employee Portal)
        └── admin/
            └── page.tsx       (457 lines — Admin Console)
```

---

## 3. Database schema (12 tables)

| Table | Purpose |
|---|---|
| `employees` | Core HR record. Arjun (E1001) and Vishy (E1002) seeded. |
| `events` | 5 life-events. Only JUST_JOINED has `is_demo_ready = TRUE`. |
| `employee_events` | Which event is active for which employee. Arjun → JUST_JOINED. Vishy → none. |
| `event_tasks` | 9-task catalogue for JUST_JOINED (3 system, 3 document, 3 connect). |
| `employee_task_status` | Per-employee task progress. All 9 tasks seeded as `pending` for Arjun. |
| `it_onboarding_submissions` | Laptop preference + drop destination + HRMS-autofilled fields. |
| `hr_profile_submissions` | PAN, bank details, IFSC, tax regime. |
| `access_requests` | GitHub username, Slack display name, additional tools. |
| `document_acceptances` | CONTRACT / CODE_OF_CONDUCT / COMPLIANCE_TRAINING acceptances. |
| `connect_meetings` | Manager intro, buddy meet, townhall bookings. |
| `admin_prompts` | Versioned system prompt. Edited via Admin Console. Agent reads on every turn. |
| `admin_tools` | Tool registry. MCP server polls every 5s. Adding a row = new agent capability, no redeploy. |
| `announcement_queue` | Backing table for the runtime-added `send_joiner_announcement` tool. |
| `agent_traces` | Per-turn observability: tool name, input, output, latency, model. |

---

## 4. Seeded data

### Employees
| ID | Name | Scenario |
|---|---|---|
| E1001 | Arjun Kumar | New joiner (joined 2 days ago). JUST_JOINED event active. All 9 tasks pending. Full onboarding cascade. |
| E1002 | Vishwanath Rao (Vishy) | Tenured (6 years). NO active event. Laptop request = standalone, no onboarding cascade. |
| E9001 | Priya Nair | Arjun's manager. Referenced in connect meeting booking. |
| E9002 | Kavita Menon | Vishy's manager. |

### Task catalogue (JUST_JOINED)
| Task code | Category | Display name |
|---|---|---|
| JJ_IT_ONBOARDING | SYSTEM | IT Onboarding Form |
| JJ_HR_PROFILE | SYSTEM | HR Profile Completion |
| JJ_ACCESS_REQUEST | SYSTEM | Access Request |
| JJ_CONTRACT | DOCUMENT | Employee Contract Signing |
| JJ_CODE_OF_CONDUCT | DOCUMENT | Code of Conduct Acceptance |
| JJ_COMPLIANCE_TRAINING | DOCUMENT | Compliance Training |
| JJ_MANAGER_INTRO | CONNECT | Intro Meeting with Manager |
| JJ_BUDDY_MEET | CONNECT | Meet Your Buddy / Mentor |
| JJ_TOWNHALL | CONNECT | New Joiner Townhall |

### System MCP tools (seeded, is_system = TRUE)
1. `get_employee_profile` → `GET hrms-api:8101/profile`
2. `list_employee_events` → `GET hrms-api:8101/events`
3. `list_pending_tasks` → `GET hrms-api:8101/tasks/pending`
4. `submit_it_onboarding` → `POST onboarding-api:8102/it-onboarding`
5. `submit_hr_profile` → `POST onboarding-api:8102/hr-profile`
6. `submit_access_request` → `POST access-api:8103/access-request`
7. `accept_document` → `POST documents-api:8104/accept`
8. `book_connect_meeting` → `POST calendar-api:8105/book`
9. `mark_task_complete` → `POST hrms-api:8101/tasks/complete`

### Runtime-added tool (NOT seeded — admin adds live during demo)
- `send_joiner_announcement` → `POST announcement-api:8107/send`
- Added via Admin Console → Tool Registry → **"+ Add announcement tool (demo shortcut)"** button
- After adding, MCP server hot-reloads within 5 seconds (poll interval)
- Agent can then call it on the next conversation turn

---

## 5. Key behaviours to verify on first run

### Demo path A — Arjun, chat-first, only laptop
1. Select Arjun (E1001)
2. Type: `I need a laptop`
3. Expected: Agent calls `get_employee_profile` → `list_employee_events` → sees JUST_JOINED active → calls `list_pending_tasks` → sees 9 pending → asks "Is only the laptop pending, or do you have other onboarding tasks too?"
4. Reply: `Only the laptop`
5. Expected: Agent asks laptop preference + drop destination → calls `submit_it_onboarding` → confirms

### Demo path B — Arjun, chat-first, full onboarding
1. Same as above through step 3
2. Reply: `I have other tasks too`
3. Expected: Agent returns the token `FORM:JUST_JOINED` → UI intercepts, strips the token, opens the modal form

### Demo path C — Vishy, standalone laptop request
1. Select Vishy (E1002)
2. Type: `I need a laptop`
3. Expected: Agent calls `get_employee_profile` → `list_employee_events` → sees NO active event → treats as standalone → asks laptop preference + drop destination → calls `submit_it_onboarding` → done. No onboarding cascade.

### Demo path D — Admin edits prompt
1. Go to `/admin` → Prompt tab
2. Edit any line in the prompt (e.g. add "Always greet the employee by first name.")
3. Save new version
4. Return to portal, send any message as Arjun
5. Expected: Footer shows `prompt v2`. Agent behaviour reflects edit.

### Demo path E — Admin adds announcement tool
1. Go to `/admin` → Tool Registry tab
2. Click **"+ Add announcement tool (demo shortcut)"**
3. Expected: Row appears in table, MCP status updates to "10 tools loaded" within 5s
4. Return to portal as Arjun, complete a few tasks, then ask: `Can you announce my joining to the team?`
5. Expected: Agent calls `send_joiner_announcement`, row appears in `announcement_queue` table

---

## 6. Known issues and things to fix

### 6.1 Things to check on first `docker compose up`

| # | Issue | Likely cause | Fix |
|---|---|---|---|
| 1 | `frontend` container fails at `npm run build` | NEXT_PUBLIC_* build args not reaching Next compiler | In `frontend/Dockerfile`, ensure `ARG` lines appear before `ENV` lines and before `RUN npm run build`. They already do — if still failing, add `--build-arg` flags explicitly to `docker compose build`. |
| 2 | `psycopg` import error in any FastAPI service | `psycopg[binary,pool]` may have version conflict on some platforms | Downgrade to `psycopg[binary]==3.1.18` + `psycopg-pool==3.2.1` in `requirements.txt` (update all 7). |
| 3 | `seed.sql` dollar-quote parsing fails on Postgres <14 | `$PROMPT$` is valid Postgres, but version matters | We use `postgres:16-alpine` so this should not occur. If swapped to an older image, replace the `$PROMPT$...$PROMPT$` block in seed.sql with a standard `E'...'` escaped string. |
| 4 | MCP server starts before admin-api is ready | `depends_on: [admin-api]` does not wait for HTTP readiness, only container start | Add a healthcheck to admin-api, OR add a startup retry loop in `mcp-server/index.js` (currently it logs a warning on failed reload and retries on next 5s poll — so it self-heals, just takes up to 5s). |
| 5 | Agent `POST /chat` returns 500 on first message | Admin-api not ready when agent first tries to load prompt | Same self-healing pattern as above. Retry from the UI. If persistent, add `--wait` to `docker compose up` or add healthcheck + `condition: service_healthy` on admin-api dependency. |

### 6.2 Missing features (intentional scope cuts — may want to add)

| # | What's missing | Where to add |
|---|---|---|
| 1 | **`infra/redis/redis.conf`** file | Referenced in UC1 lab content for the Redis config lesson. Needs to be added to the repo even if default config is fine. Create `infra/redis/redis.conf` with `maxmemory-policy allkeys-lru` and `maxmemory 256mb`. docker-compose already passes these as command args, so the file is just for the lab narrative. |
| 2 | **Health check endpoints on all FastAPI services** | All 7 services have `GET /health` returning `{"status":"ok","service":"..."}` — but docker-compose healthchecks are not wired. Add `healthcheck` block to each service in docker-compose.yml for production-quality startup ordering. |
| 3 | **`infra/db/init.sh`** or separate seed toggle | Currently schema + seed both run via `docker-entrypoint-initdb.d`. If postgres volume already exists (i.e. second `docker compose up`), the init scripts do NOT re-run (Postgres skips them if data directory is already initialised). This is correct behaviour, but worth documenting explicitly in README. |
| 4 | **Frontend `.env.local`** for running locally outside Docker | If developer runs `npm run dev` directly (not via Docker), the NEXT_PUBLIC_* vars need to be in `frontend/.env.local`. Add a `frontend/.env.local.example` with all vars set to `http://localhost:PORT`. |
| 5 | **`mcp-server/tools/` folder** exists but is empty | Originally planned for one-file-per-tool pattern (matching UC1). Decided against it in favour of DB-driven registry. Folder can be removed, or documented as "reserved for future static tool overrides". |
| 6 | **Document/Contract UI tab in modal** | The `OnboardingFormModal` in `page.tsx` has IT / HR / ACCESS tabs but no DOCUMENT tab (contract, CoC, compliance). These are only accessible via chat. Either add a DOCUMENT tab to the modal, or clarify in the demo that documents are chat-only. |
| 7 | **Connect meetings UI tab in modal** | Same — CONNECT meeting booking (manager intro, buddy, townhall) is chat-only. Modal does not cover it. Same fix options as above. |
| 8 | **`agent_traces` table is defined but never written to** | The schema has `agent_traces` for observability. The agent returns trace data to the frontend in the API response but does not persist it to the DB. Add a `POST /agent_traces` route to hrms-api (or a dedicated traces-api) and call it from `agent/index.js` after each turn. Alternatively, cut the table and document that traces are in-memory only (the frontend trace panel already shows them). |
| 9 | **No `Tailwind` — raw CSS only** | The frontend uses raw inline styles + `globals.css` CSS variables. This is intentional (no compiler dependency) but inconsistent with any UC1 tooling that used Tailwind. Not a bug — just document the design choice. |
| 10 | **Announcement API uses CSV string for `recipient_list`** | `announcement-api/app/main.py` accepts `recipient_list` as a plain `str` (CSV). The Admin Console's demo shortcut hardcodes it as a string too. The `admin_tools` seed has it typed as `"type":"string"` in the schema, which matches. However the standalone `POST /announce` endpoint in the newer version of the file I attempted to overwrite used `List[str]`. **These are now consistent (both string)** — just make sure no other call site passes an array. |

### 6.3 Lab document note (flagged in conversation)

> **Include this command at the top of Lab 1, before `docker compose up`:**
>
> ```powershell
> docker compose -p vision-enterprise down
> ```
>
> **Explanation to include:** "This shuts down any running containers from Use Case 1 (the shopping experience). The `-p vision-enterprise` flag targets the UC1 project specifically. Run this before starting UC2 to avoid port conflicts on 5432, 6379, and 3000."

---

## 7. What was NOT built yet (next steps)

### Scripts
Following the same format as UC1 scripts (beat-by-beat, dual-audience, camera/screen cues).

**Leadership track for UC2:**
- UC2.0 — Bridge video (2 min): "What's the same, what's new, where the course splits"
- UC2.1 — Business Context: Onboarding as a leaky bucket (8 min)
- UC2.2 — Solution Concept + Live Demo walkthrough (12 min)
- UC2.3 — Governance for Internal AI: PII, access creep, prompt-as-policy (7 min)
- UC2.4 — ROI & Rollout: time-to-productivity, ticket deflection, HR hours saved (6 min)

**Practitioner track for UC2:**
- UC2.P1 — Architecture Deep Dive: what's reused from UC1, what's new (12 min)
- UC2.P2 — Environment Setup: docker compose up, seed, smoke test (8 min)
- UC2.P3 — Lab 1: Data Layer
- UC2.P4 — Lab 2: Services + MCP tools
- UC2.P5 — Lab 3: Agent + Admin prompt editor + add announcement tool live
- UC2.P6 — Extension Challenges (5 min)

### Labs (three hands-on labs)
Following the same format as `lab-02-microservices-and-mcp-server.md` in the project.

| Lab | Scope | Climax |
|---|---|---|
| Lab 1 — Data Layer | Schema, HRMS dummy seed, Redis cache-hit/miss experiment | Prove Redis cache works: call profile twice, see `_cache: miss` then `_cache: hit` |
| Lab 2 — Services + MCP | Stand up all 7 FastAPI services + MCP gateway, call tools from terminal | Call `book_connect_meeting` directly via MCP `POST /tools/call` and see the DB row appear |
| Lab 3 — Agent + Admin | Full chat flow end-to-end, then live prompt edit, then add announcement tool | Add `send_joiner_announcement` via Admin Console, verify MCP reloads, trigger from chat |

> **Lab 1 must begin with:**
> ```powershell
> docker compose -p vision-enterprise down
> ```
> (see section 6.3 above)

---

## 8. Model configuration

The model-switching story (matches UC1) is controlled by a single env var:

```env
MODEL_PROVIDER=anthropic    # or: openai
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-sonnet-4-5

# OR:
MODEL_PROVIDER=openai
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o
```

The provider abstraction is in `agent/lib/provider.js`. Both providers expose the same `runTurn()` surface. The agent loop in `agent/index.js` is provider-agnostic. Switching providers requires only changing `.env` and restarting the agent container — no code change.

---

## 9. The demo climax — how the admin-adds-tool story works technically

This is the centrepiece of UC2 and the most important thing to preserve in any refactor:

1. `admin_tools` table in Postgres is the single source of truth for what tools exist.
2. MCP server (`mcp-server/index.js`) polls `GET admin-api:8106/tools` every **5000ms** and rebuilds its in-memory `toolRegistry`.
3. Agent (`agent/index.js`) calls `GET mcp-server:8100/tools?event_code=JUST_JOINED` on **every turn** to get the current tool list.
4. Admin Console (`frontend/app/admin/page.tsx`) calls `POST admin-api:8106/tools` to add a new row, then immediately calls `POST mcp-server:8100/tools/reload` to force an instant registry refresh (no waiting for the 5s poll).
5. On the very next agent turn, the new tool is in the list the agent receives. The agent's prompt says "tools may be added by the administrator at runtime — read each tool's description carefully."
6. The agent calls the new tool. The call routes through MCP → `announcement-api:8107/send` → row in `announcement_queue`.

**Nothing is redeployed. No container restarts. The entire flow is live within ~2 seconds of clicking the button.**

---

*End of CLAUDE.md*
