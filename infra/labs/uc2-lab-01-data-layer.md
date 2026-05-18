# Lab 1: Data Layer and Postgres

**Estimated time:** 30–40 minutes
**Audience:** Fresh graduates learning AI-powered enterprise applications
**Series:** This is Lab 1 of 3 for the Employee Experience use case. Labs 2 and 3 build on what you set up here.

---

## Learning Objectives

By the end of this lab you will be able to:

1. Explain why the AI Agent powered Employee Portal separates concerns into three layers — data, services, and agent
2. Read the `docker-compose.yml` and explain what every key section does
3. Describe the 14-table schema and group the tables by responsibility (core, task model, submissions, admin, observability)
4. Connect to PostgreSQL and verify the seeded employees, the task catalogue, and the two-tier system prompt
5. Explain why both the **agent's prompt** and the **agent's tool registry** are stored in database tables — not in source code
6. Use Redis to demonstrate a cache miss followed by a cache hit on the HRMS profile fetch

---

## What You Are Building

Vision Enterprise Use Case 2 is an AI Agent powered Employee Portal that guides a new joiner through onboarding. In this lab you will bring up just the **data layer** — the two infrastructure services that everything else depends on:

```
┌─────────────────────────────────────────────────────────────┐
│                    ve-uc2-internal network                   │
│                                                             │
│  ┌─────────────────────┐         ┌──────────────────┐      │
│  │     PostgreSQL      │         │      Redis       │      │
│  │     port 5432       │         │    port 6379     │      │
│  │                     │         │                  │      │
│  │  CORE                │         │   profile cache  │      │
│  │   employees          │         │   60-second TTL  │      │
│  │   events             │         │                  │      │
│  │   employee_events    │         │                  │      │
│  │                     │         │                  │      │
│  │  TASK MODEL          │         │                  │      │
│  │   event_tasks        │         │                  │      │
│  │   employee_task_status│        │                  │      │
│  │                     │         │                  │      │
│  │  SUBMISSIONS         │         │                  │      │
│  │   it_onboarding      │         │                  │      │
│  │   hr_profile         │         │                  │      │
│  │   access_requests    │         │                  │      │
│  │   document_acceptances│        │                  │      │
│  │   connect_meetings   │         │                  │      │
│  │                     │         │                  │      │
│  │  ADMIN (the climax)  │         │                  │      │
│  │   admin_prompts      │         │                  │      │
│  │   admin_tools        │         │                  │      │
│  │                     │         │                  │      │
│  │  OBSERVABILITY       │         │                  │      │
│  │   announcement_queue │         │                  │      │
│  │   agent_traces       │         │                  │      │
│  └─────────────────────┘         └──────────────────┘      │
│             ▲                                                │
│             │   schema.sql + seed.sql run on first start    │
│             │   (docker-entrypoint-initdb.d)                │
└─────────────────────────────────────────────────────────────┘
```

The two tables to circle: **`admin_prompts`** and **`admin_tools`**. They are the centrepiece of the whole use case. The agent's instructions and the agent's capabilities both live as rows in a database — editable at runtime by an administrator with no code change.

---

## Prerequisites

Before you begin, make sure you have:

- [ ] **Docker Desktop** installed and running (version 4.x or later)
  - Mac/Windows: https://www.docker.com/products/docker-desktop
  - Linux: install Docker Engine + Docker Compose plugin
- [ ] **Git** to clone the repository
- [ ] **A text editor** (VS Code recommended)
- [ ] **An Anthropic API key** — you will need this in Lab 3 for the agent itself
  - Get one at: https://console.anthropic.com
- [ ] **If you completed Use Case 1** — stop those containers first to avoid port conflicts on 5432, 6379, and 3000:

```bash
docker compose -p vision-enterprise down
```

The `-p vision-enterprise` flag targets the UC1 project specifically. UC2 uses its own project name so the two can coexist on disk but should not run at the same time.

---

## Setup: Clone and Configure

```bash
# 1. Clone the repository
git clone https://github.com/mandar-productpathfinders/vision-employee-experience.git
cd vision-employee-experience

# 2. Copy the example environment file
cp .env.example .env

# 3. Open .env in your editor and fill in your API key
#    Find the line:  ANTHROPIC_API_KEY=
#    Change it to:   ANTHROPIC_API_KEY=sk-ant-...your-key-here...
```

> **Why .env?** Docker Compose reads this file and injects values into containers as environment variables. This keeps secrets out of your code and out of `docker-compose.yml`.

---

## Section 1: Project Structure Walkthrough

Open the project root in your editor. Here is what each top-level directory contains:

```
vision-employee-experience/
├── .env                  ← Your secrets and configuration (never commit this)
├── .env.example          ← Template showing all required variables
├── docker-compose.yml    ← The "blueprint" for the entire system
│
├── infra/
│   └── db/
│       ├── schema.sql    ← 14 tables, 10 indexes — run on first Postgres start
│       └── seed.sql      ← Events, tasks, 2 employees, prompts, 9 tools
│
├── services/             ← Seven FastAPI microservices (Lab 2 covers these)
│   ├── hrms-api/         ← Profile, events, pending tasks  (port 8101)
│   ├── onboarding-api/   ← IT onboarding + HR profile forms (port 8102)
│   ├── access-api/       ← GitHub, Slack, additional tools  (port 8103)
│   ├── documents-api/    ← Contract, code of conduct, training (port 8104)
│   ├── calendar-api/     ← Manager intro, buddy, townhall    (port 8105)
│   ├── admin-api/        ← Prompt and tool registry          (port 8106)
│   └── announcement-api/ ← The runtime-added tool target     (port 8107)
│
├── mcp-server/           ← AI tool gateway, Node.js          (port 8100)
├── agent/                ← The onboarding agent, Node.js     (port 8200)
└── frontend/             ← Next.js Employee Portal + Admin Console (port 3000)
```

**Key insight:** Each service in `services/` has its own `main.py` and `Dockerfile`. It can be developed, deployed, and scaled independently. This is the microservice pattern.

---

## Section 2: Reading docker-compose.yml

Open `docker-compose.yml`. This is the single file that defines the entire system. Let's understand it piece by piece.

### 2.1 The Postgres Service Block

```yaml
postgres:
  image: postgres:16-alpine          # Docker image to use
  container_name: ve-uc2-postgres    # Name used in docker commands
  ports:
    - "5432:5432"                    # host_port:container_port
  volumes:
    - postgres-uc2-data:/var/lib/postgresql/data           # persist data
    - ./infra/db:/docker-entrypoint-initdb.d:ro            # auto-run SQL on first start
  environment:
    POSTGRES_DB: vision_uc2
    POSTGRES_USER: ve_user
    POSTGRES_PASSWORD: ve_pass_dev
  healthcheck:
    test: ["CMD-SHELL", "pg_isready -U ve_user -d vision_uc2"]
    interval: 5s
    retries: 10
  networks:
    - ve-uc2-internal
```

Key concepts:
- **ports:** `"5432:5432"` means "expose container port 5432 as host port 5432"
- **volumes:** `postgres-uc2-data` is a named Docker volume — your data survives `docker compose down`
- **`docker-entrypoint-initdb.d`:** Postgres automatically runs any `.sql` files in this directory the **first time** the container starts. This is how `schema.sql` and `seed.sql` get loaded.
- **healthcheck:** Docker polls this command; services with `depends_on: condition: service_healthy` wait for it to pass
- **networks:** All services on `ve-uc2-internal` can reach each other by container name (for example, `http://hrms-api:8101`)

### 2.2 The Redis Service Block

```yaml
redis:
  image: redis:7-alpine
  container_name: ve-uc2-redis
  ports:
    - "6379:6379"
  command: redis-server --maxmemory 256mb --maxmemory-policy allkeys-lru
  networks:
    - ve-uc2-internal
```

The `command:` override caps Redis at 256MB and tells it to evict the least-recently-used keys when the cap is reached. This is the right policy for a cache (versus, say, an event queue, where eviction would lose data).

### 2.3 Why Postgres and Redis (and Not a Vector Database)?

The Use Case 1 architecture uses a vector database (pgvector) because product search is fundamentally a similarity problem. Use Case 2 is different — the agent does **not** do similarity search. It does **structured lookups**: who is this employee, what life-event are they in, which tasks are pending, what is in the tool registry. Postgres is the right shape for all of these.

| Store | What it holds | Why this shape |
|-------|---------------|---------------|
| **PostgreSQL** | All operational state — employees, events, tasks, submissions, prompts, tools, traces | Joins, foreign keys, JSONB for flexible schemas, transactional |
| **Redis** | HRMS profile cache (60s TTL) | The agent reads the HR profile on every turn — a hot read worth caching |

If a future life-event needed similarity search (for example "find similar past joiners"), pgvector would be the obvious addition. This use case does not need it.

---

## Section 3: Starting Infrastructure Services

Start only the infrastructure services (not the application services yet):

```bash
docker compose up -d postgres redis
```

The `-d` flag means **detached** — services run in the background.

Check that they started:

```bash
docker compose ps
```

You should see two containers with status `healthy` or `running`. The `healthcheck` in docker-compose.yml is what determines the healthy state. Wait up to 30 seconds if they are still showing as "starting".

To see what is happening inside a container:

```bash
docker compose logs postgres
```

You should see Postgres run `schema.sql` and `seed.sql` from the entrypoint directory on first start. If you see lines like `CREATE TABLE` and `INSERT 0 1`, the seed is happening as designed.

---

## Section 4: The Seed Data

Unlike Use Case 1, the seed for Use Case 2 is plain SQL — there is no Python script that runs separately. Both `schema.sql` and `seed.sql` are auto-executed by Postgres on first start (because they live in `infra/db/` which is mounted to `/docker-entrypoint-initdb.d`).

What gets seeded:

1. **5 life-events** in the `events` table — only `JUST_JOINED` is `is_demo_ready = TRUE` for this release
2. **9 onboarding tasks** in `event_tasks` — three categories, three tasks each (SYSTEM, DOCUMENT, CONNECT)
3. **2 employees** in `employees` — Arjun (E1001, new joiner) and Vishy (E1002, six-year tenured)
4. **2 managers** — Priya Nair (E9001) and Kavita Menon (E9002) — so foreign keys for connect meetings resolve
5. **1 active event** in `employee_events` — Arjun is in JUST_JOINED, Vishy is not
6. **9 task rows** in `employee_task_status` — all of Arjun's onboarding tasks are pending
7. **2 prompts** in `admin_prompts` — a ROUTER dispatcher prompt and a JUST_JOINED specialist prompt (this is the two-tier prompt design — see Section 6)
8. **9 system tools** in `admin_tools` — every back-end action the agent can take

> **What is intentionally NOT seeded?** The `send_joiner_announcement` tool. It exists as a microservice (announcement-api), and the schema supports it, but the row in `admin_tools` is left out. This is on purpose — Lab 3 has you add it live, watch the MCP server pick it up within 5 seconds, and then watch the agent call it. That demo only works if the tool is missing from the seed.

> **Why `ON CONFLICT DO NOTHING` on the seeds?** It makes the seed idempotent. If Postgres is restarted with the data volume intact, the entrypoint scripts re-run but the INSERTs are no-ops. If you want to reset to a known state, run `docker compose down -v` to delete the volume.

---

## Section 5: The Relational Schema

Connect to PostgreSQL:

```bash
docker exec -it ve-uc2-postgres psql -U ve_user -d vision_uc2
```

You are now in the `psql` prompt. Type `\dt` to list all tables:

```
                List of relations
 Schema |          Name              | Type  |  Owner
--------+----------------------------+-------+---------
 public | access_requests            | table | ve_user
 public | admin_prompts              | table | ve_user
 public | admin_tools                | table | ve_user
 public | agent_traces               | table | ve_user
 public | announcement_queue         | table | ve_user
 public | connect_meetings           | table | ve_user
 public | document_acceptances       | table | ve_user
 public | employee_events            | table | ve_user
 public | employee_task_status       | table | ve_user
 public | employees                  | table | ve_user
 public | event_tasks                | table | ve_user
 public | events                     | table | ve_user
 public | hr_profile_submissions     | table | ve_user
 public | it_onboarding_submissions  | table | ve_user
```

Fourteen tables, grouped into six categories.

### 5.1 Core — employees, events, employee_events

**`employees`** — Each row is a person:
```sql
SELECT employee_id, full_name, department, designation, manager_name
FROM employees ORDER BY employee_id;
```

You should see at least four rows: Arjun (E1001), Vishy (E1002), Priya Nair (E9001), Kavita Menon (E9002). Arjun and Vishy are the two demo personas. Priya and Kavita are managers — they exist so that foreign keys in `connect_meetings` resolve cleanly.

**`events`** — The life-event registry:
```sql
SELECT event_code, display_name, is_demo_ready FROM events ORDER BY sort_order;
```

You will see five events: ROUTER (a system event for the dispatcher prompt — not for employees), JUST_JOINED, TRAVEL, PROMOTION, YEAR_END, PARENTAL_LEAVE. Only JUST_JOINED has `is_demo_ready = TRUE`. The others are scaffolding for future versions.

**`employee_events`** — Which event is active for which employee:
```sql
SELECT employee_id, event_code, status FROM employee_events;
```

You should see one row: Arjun is in JUST_JOINED, status active. Vishy intentionally has no row — this is the demo contrast in Lab 3 (Vishy asking for a laptop hits the agent's standalone request path, Arjun asking for a laptop hits the onboarding cascade).

### 5.2 Task Model — event_tasks, employee_task_status

**`event_tasks`** — The task catalogue for each event:
```sql
SELECT task_code, category, display_name, sort_order
FROM event_tasks WHERE event_code = 'JUST_JOINED'
ORDER BY sort_order;
```

Nine rows in three categories:

| task_code | category | display_name |
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

**`employee_task_status`** — Per-employee task progress:
```sql
SELECT employee_id, task_code, status FROM employee_task_status
WHERE employee_id = 'E1001';
```

All 9 rows for Arjun should show `pending`. As the agent completes tasks in Lab 3, rows here flip to `completed`.

### 5.3 Submissions — Four tables, one per form

The four submission tables capture the actual data the employee provides:

| Table | What it captures |
|---|---|
| `it_onboarding_submissions` | Laptop preference (Mac/HP/Dell), drop destination, work number, emergency contact, cost centre |
| `hr_profile_submissions` | PAN, bank name, bank account, IFSC, tax regime |
| `access_requests` | GitHub username, Slack display name, additional tools |
| `document_acceptances` | Document type (CONTRACT / CODE_OF_CONDUCT / COMPLIANCE_TRAINING) + accepted flag |

These are intentionally separate tables (rather than one wide table) because each submission has different fields, different lifetimes, and different downstream consumers. Postgres encourages normalisation; we follow that convention.

### 5.4 Connect Meetings

```sql
\d connect_meetings
```

One table for all three meeting types — MANAGER_INTRO, BUDDY_MEET, TOWNHALL. The `meeting_type` column discriminates. `preferred_dates` is CSV (the employee offers; the booking logic picks one). `booked_slot` is the final timestamp.

### 5.5 Admin — The Centrepiece

This is the heart of the use case. Two tables — `admin_prompts` and `admin_tools` — control what the agent says and what it can do. Both are editable at runtime through the Admin Console (Lab 3).

We will spend the rest of this lab on these two tables.

### 5.6 Observability

**`announcement_queue`** is the backing table for the runtime-added `send_joiner_announcement` tool. Every announcement the agent triggers becomes a row here.

**`agent_traces`** is scaffolded for per-turn observability — tool name, input, output, latency, model. The agent currently returns the trace in its HTTP response but does not write to this table yet (that is Practitioner Challenge 2 from Part 2 of the blog series — wire trace persistence to the database).

Type `\q` to exit psql. We will come back.

---

## Section 6: The Two-Tier Prompt — admin_prompts

This is the first of the two "prompt-as-policy" tables. Reconnect:

```bash
docker exec -it ve-uc2-postgres psql -U ve_user -d vision_uc2
```

List the prompts:
```sql
SELECT event_code, version, is_active, updated_by, updated_at FROM admin_prompts ORDER BY event_code;
```

Expected output:
```
 event_code  | version | is_active | updated_by    |          updated_at
-------------+---------+-----------+---------------+-------------------------------
 JUST_JOINED |       1 | t         | system-init   | 2026-...
 ROUTER      |       1 | t         | system-init   | 2026-...
```

Two prompts. Both at version 1. Both active.

### Why Two Prompts and Not One?

When the agent receives a chat turn, it loads both prompts from this table and concatenates them, separated by a `---` divider. The model sees one combined system prompt. The source of truth is two independently editable rows.

| Prompt | Role | What it contains |
|---|---|---|
| **ROUTER** | Dispatcher | The startup sequence: call get_employee_profile, call list_employee_events, route based on which event is active. If JUST_JOINED → follow the specialist below. If no event → handle as a standalone request. |
| **JUST_JOINED** | Specialist | The full onboarding rules: task catalogue, within-category sequencing, the rule against re-asking for HR-known data, the hand-off-to-form rule using the literal token `FORM:JUST_JOINED`. |

The reason to split is **change control**. The HR team owns the JUST_JOINED prompt. Operations owns the ROUTER. They can edit independently without stepping on each other.

### Read the ROUTER Prompt

```sql
SELECT prompt_text FROM admin_prompts WHERE event_code = 'ROUTER' AND is_active = TRUE;
```

You should see the four-step startup sequence. The key line: *"Perform the startup sequence silently. Do not narrate steps 1–3 to the employee."* The agent always reads the profile and the active event before saying anything — but it does not tell the employee that.

### Read the JUST_JOINED Prompt

```sql
SELECT prompt_text FROM admin_prompts WHERE event_code = 'JUST_JOINED' AND is_active = TRUE;
```

You will see four sections: TASK AWARENESS, TASK SEQUENCING, CONVERSATION RULES, TOOL USAGE, STYLE. Read the SEQUENCING block — it is the most interesting part. Tasks within a category have an order (a DOCUMENT before a DOCUMENT, a CONNECT before a CONNECT) but the three categories are independent of each other. This is exactly how a sensible onboarding experience should work; the prompt encodes that policy directly.

### Why Prompts in a Database, Not in Code?

Most teams hardcode prompts in source files. The problem: every tweak — a new sequencing rule, a tone change, a different greeting — requires an engineer to edit code, get it reviewed, and deploy.

With prompts as data:
- An HR or operations administrator edits the text in the Admin Console (Lab 3)
- They click Save
- The next agent turn picks up the new version automatically — the agent calls `GET /prompt/{event_code}` on every turn
- The old version is archived in the same table (`is_active = FALSE`, `version = old`) so the change history is preserved

This is the same pattern used in production AI systems. **The prompt is operational configuration, not source code.** You can `SELECT * FROM admin_prompts ORDER BY event_code, version` and reconstruct every policy change anyone has ever made.

---

## Section 7: The Tool Registry — admin_tools

This is the second "policy-as-data" table and the one that delivers the most spectacular demo in Lab 3.

```sql
SELECT tool_name, is_system, is_active, http_method FROM admin_tools ORDER BY is_system DESC, tool_name;
```

Expected — nine rows, all `is_system = t`, all active:

```
        tool_name        | is_system | is_active | http_method
-------------------------+-----------+-----------+-------------
 accept_document         | t         | t         | POST
 book_connect_meeting    | t         | t         | POST
 get_employee_profile    | t         | t         | GET
 list_employee_events    | t         | t         | GET
 list_pending_tasks      | t         | t         | GET
 mark_task_complete      | t         | t         | POST
 submit_access_request   | t         | t         | POST
 submit_hr_profile       | t         | t         | POST
 submit_it_onboarding    | t         | t         | POST
```

Each row defines one tool the agent can call. The columns:

| Column | Purpose |
|---|---|
| `tool_name` | snake_case name. This is what the LLM uses to call the tool. |
| `display_name` | Human-readable name for the Admin Console UI. |
| `description` | Written **for the LLM**. The model reads this on every turn to decide whether to call the tool. |
| `input_schema` | JSON Schema for the tool's arguments. Enforces shape. |
| `endpoint_url` | The microservice URL the MCP server will dispatch to. |
| `http_method` | GET, POST, PUT, DELETE. |
| `event_code` | Optional — scope the tool to one life-event. `NULL` means available in any context. |
| `is_active` | Soft on/off switch. |
| `is_system` | TRUE = built-in (cannot delete via Admin Console). FALSE = admin-added (can be deleted). |

### Inspect One Tool in Full

```sql
SELECT tool_name, description, jsonb_pretty(input_schema) AS schema
FROM admin_tools WHERE tool_name = 'submit_it_onboarding';
```

Read the description carefully. Phrases like *"Work number, emergency contact and cost centre are taken from their HRMS profile automatically"* are written so the LLM knows it should **not ask** the employee for those fields. The description is, in effect, a small slice of the agent's behaviour. **The description is prompt engineering for one tool at a time.**

### The Missing Tool

Try this:
```sql
SELECT tool_name FROM admin_tools WHERE tool_name = 'send_joiner_announcement';
```

Zero rows. The tool does not exist yet. The announcement-api microservice exists (you will see it in Lab 2). The schema supports the row. But the seed deliberately leaves it out. In Lab 3 you will INSERT this row through the Admin Console UI, wait five seconds for the MCP server to refresh, and watch the agent use the new capability.

This is the centrepiece of the use case: **agent capabilities are data, and data can be edited at runtime.**

### Three Consequences of This Design

1. **Capabilities are auditable.** `SELECT * FROM admin_tools` is a complete answer to "what could the agent have done at this point in time?"
2. **Capabilities are time-bound.** `UPDATE admin_tools SET is_active = FALSE WHERE tool_name = 'X'` removes a capability immediately on the next MCP poll.
3. **Capabilities are reversible.** The same INSERT/UPDATE/DELETE that adds a tool removes it. No deploy, no rollback, no incident bridge.

Type `\q` to exit psql.

---

## Section 8: Redis — The Profile Cache

Redis is an in-memory key-value store. It is much faster than PostgreSQL for repeated reads of the same data (microseconds vs milliseconds).

In Use Case 2, Redis caches one thing: **the HRMS profile**. The agent reads the profile at the start of every conversation turn — the ROUTER prompt says so. Without caching, every turn would hit Postgres and run a query that joins employees + employee_events + employee_task_status. With caching, the first turn is a database read; the next several turns within 60 seconds are Redis reads.

| Cache Key | What it stores | TTL |
|-----------|---------------|-----|
| `profile:{employee_id}` | The full HR profile + active events + pending task count | 60 seconds |

> **Why a 60-second TTL?** Long enough that a multi-turn conversation reads from cache. Short enough that a profile update (for example, a manager change) becomes visible quickly. If you wanted the agent to react instantly to profile changes, you would lower this further or move to event-driven invalidation.

Connect to Redis and confirm it is reachable:

```bash
docker exec -it ve-uc2-redis redis-cli ping
```

Expected: `PONG`

We cannot test cache hit/miss yet — that requires the hrms-api service, which you will start in Lab 2. Test cases T1.11 and T1.12 below come back to verify it after Lab 2 is complete.

---

## Test Cases — Lab 1

Run each command and verify the expected output. These are your acceptance criteria for Lab 1.

```bash
# T1.1 — Infrastructure containers are healthy
docker compose ps
# Expected: postgres and redis show status "running" or "healthy"

# T1.2 — Schema was created (14 tables)
docker exec -it ve-uc2-postgres psql -U ve_user -d vision_uc2 \
  -c "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public';"
# Expected:  count
#           -------
#              14

# T1.3 — Both demo employees exist
docker exec -it ve-uc2-postgres psql -U ve_user -d vision_uc2 \
  -c "SELECT employee_id, full_name, department FROM employees WHERE employee_id IN ('E1001','E1002');"
# Expected: 2 rows — Arjun Kumar (Engineering), Vishwanath Rao (Product)

# T1.4 — Arjun is in JUST_JOINED, Vishy is not
docker exec -it ve-uc2-postgres psql -U ve_user -d vision_uc2 \
  -c "SELECT employee_id, event_code, status FROM employee_events ORDER BY employee_id;"
# Expected: 1 row — E1001, JUST_JOINED, active
# (Vishy E1002 has no row — this is the demo contrast)

# T1.5 — Task catalogue has 9 tasks across 3 categories
docker exec -it ve-uc2-postgres psql -U ve_user -d vision_uc2 \
  -c "SELECT category, COUNT(*) FROM event_tasks WHERE event_code='JUST_JOINED' GROUP BY category ORDER BY category;"
# Expected: CONNECT 3, DOCUMENT 3, SYSTEM 3

# T1.6 — All 9 of Arjun's tasks are pending
docker exec -it ve-uc2-postgres psql -U ve_user -d vision_uc2 \
  -c "SELECT status, COUNT(*) FROM employee_task_status WHERE employee_id='E1001' GROUP BY status;"
# Expected: pending 9

# T1.7 — Two prompts seeded: ROUTER and JUST_JOINED
docker exec -it ve-uc2-postgres psql -U ve_user -d vision_uc2 \
  -c "SELECT event_code, version, is_active FROM admin_prompts ORDER BY event_code;"
# Expected:
#  event_code  | version | is_active
# -------------+---------+-----------
#  JUST_JOINED |       1 | t
#  ROUTER      |       1 | t

# T1.8 — Nine system tools seeded, none admin-added yet
docker exec -it ve-uc2-postgres psql -U ve_user -d vision_uc2 \
  -c "SELECT is_system, COUNT(*) FROM admin_tools GROUP BY is_system;"
# Expected: is_system=t count=9
# (No is_system=f rows — those would be admin-added; you will add one in Lab 3)

# T1.9 — The announcement tool is intentionally missing
docker exec -it ve-uc2-postgres psql -U ve_user -d vision_uc2 \
  -c "SELECT COUNT(*) FROM admin_tools WHERE tool_name='send_joiner_announcement';"
# Expected: count = 0 (you will add this in Lab 3)

# T1.10 — Submissions tables are empty (nobody has filled a form yet)
docker exec -it ve-uc2-postgres psql -U ve_user -d vision_uc2 \
  -c "SELECT
        (SELECT COUNT(*) FROM it_onboarding_submissions)  AS it_count,
        (SELECT COUNT(*) FROM hr_profile_submissions)     AS hr_count,
        (SELECT COUNT(*) FROM access_requests)            AS access_count,
        (SELECT COUNT(*) FROM document_acceptances)       AS doc_count,
        (SELECT COUNT(*) FROM connect_meetings)           AS meeting_count;"
# Expected: all five counts = 0

# T1.11 — Redis is reachable
docker exec -it ve-uc2-redis redis-cli ping
# Expected: PONG

# T1.12 — Redis profile cache is empty (no profile reads yet)
docker exec -it ve-uc2-redis redis-cli keys 'profile:*'
# Expected: (empty array)
# After Lab 2 you will run a profile fetch and a second key 'profile:E1001' will appear.
```

All 12 tests passing means your data layer is ready for Lab 2.

---

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| `docker compose ps` shows "starting" for >60s | Docker image still downloading | Wait, then `docker compose logs postgres` |
| Postgres logs show "could not bind to port 5432" | UC1 Postgres still running | `docker compose -p vision-enterprise down`, then retry |
| `psql: command not found` | Running locally instead of in the container | Use `docker exec -it ve-uc2-postgres psql ...` |
| `\dt` shows 0 tables | Schema did not run — likely a re-attached volume from a previous broken run | `docker compose down -v` to wipe the volume, then `docker compose up -d postgres redis` |
| `admin_prompts` table has 0 rows | Seed did not complete | `docker compose logs postgres | grep -i error` |
| Tools count is not 9 | Same as above — re-seed | `docker compose down -v`, then `docker compose up -d postgres redis` |

---

## Summary

In this lab you:

1. Cloned the public repository and understood the three-layer architecture
2. Read `docker-compose.yml` and understood how Postgres and Redis are configured
3. Started two infrastructure services and watched the schema and seed scripts auto-run
4. Walked through the 14-table schema grouped by responsibility
5. Read the two seeded prompts — ROUTER and JUST_JOINED — and understood why the two-tier split exists
6. Inspected the seeded tool registry and noted the intentionally-missing `send_joiner_announcement` row
7. Connected to Redis and confirmed it is reachable for the profile cache

The two ideas worth carrying into Lab 2 are: **the agent's instructions are data** (admin_prompts) and **the agent's capabilities are data** (admin_tools). Everything in Lab 2 is built around making these two tables drive the running system.

**Next:** In Lab 2 you will start the seven FastAPI microservices and the MCP server. The MCP server reads `admin_tools` and exposes each active row as a tool — and reloads itself every five seconds so changes to the table are visible to the agent within seconds.
