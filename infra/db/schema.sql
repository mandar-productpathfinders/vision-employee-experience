-- =============================================================================
-- Vision Enterprise  —  Use Case 2: Employee Experience Transformation
-- PostgreSQL schema
-- =============================================================================
-- Layers: employees/events -> tasks -> submissions -> admin/announcements
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- -----------------------------------------------------------------------------
-- CORE: employees + events
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS employees (
    employee_id       VARCHAR(20)   PRIMARY KEY,
    full_name         VARCHAR(200)  NOT NULL,
    email             VARCHAR(200)  UNIQUE NOT NULL,
    gender            VARCHAR(20),
    date_of_joining   DATE          NOT NULL,
    manager_id        VARCHAR(20),
    manager_name      VARCHAR(200),
    department        VARCHAR(100),
    designation       VARCHAR(100),
    cost_center       VARCHAR(50),
    work_number       VARCHAR(50),
    emergency_contact VARCHAR(50),
    location          VARCHAR(100),
    is_active         BOOLEAN       DEFAULT TRUE,
    created_at        TIMESTAMPTZ   DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_employees_manager ON employees(manager_id);

-- Lookup of the five events. Only JUST_JOINED is demo-ready in v1.
CREATE TABLE IF NOT EXISTS events (
    event_code     VARCHAR(30)  PRIMARY KEY,
    display_name   VARCHAR(100) NOT NULL,
    description    TEXT,
    is_demo_ready  BOOLEAN      DEFAULT FALSE,
    sort_order     INTEGER      DEFAULT 0
);

-- Which events are currently active for an employee.
CREATE TABLE IF NOT EXISTS employee_events (
    id            SERIAL       PRIMARY KEY,
    employee_id   VARCHAR(20)  NOT NULL REFERENCES employees(employee_id),
    event_code    VARCHAR(30)  NOT NULL REFERENCES events(event_code),
    status        VARCHAR(20)  DEFAULT 'active',  -- active | completed | cancelled
    triggered_at  TIMESTAMPTZ  DEFAULT NOW(),
    completed_at  TIMESTAMPTZ,
    UNIQUE(employee_id, event_code)
);
CREATE INDEX IF NOT EXISTS idx_emp_events_emp    ON employee_events(employee_id);
CREATE INDEX IF NOT EXISTS idx_emp_events_status ON employee_events(status);

-- -----------------------------------------------------------------------------
-- TASK MODEL: event task catalogue + per-employee state
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS event_tasks (
    task_code     VARCHAR(50)  PRIMARY KEY,
    event_code    VARCHAR(30)  NOT NULL REFERENCES events(event_code),
    category      VARCHAR(30)  NOT NULL,   -- SYSTEM | DOCUMENT | CONNECT
    display_name  VARCHAR(200) NOT NULL,
    description   TEXT,
    sort_order    INTEGER      DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_event_tasks_event ON event_tasks(event_code);

CREATE TABLE IF NOT EXISTS employee_task_status (
    id            SERIAL       PRIMARY KEY,
    employee_id   VARCHAR(20)  NOT NULL REFERENCES employees(employee_id),
    task_code     VARCHAR(50)  NOT NULL REFERENCES event_tasks(task_code),
    status        VARCHAR(20)  DEFAULT 'pending',   -- pending | in_progress | completed
    updated_at    TIMESTAMPTZ  DEFAULT NOW(),
    UNIQUE(employee_id, task_code)
);
CREATE INDEX IF NOT EXISTS idx_task_status_emp ON employee_task_status(employee_id);

-- -----------------------------------------------------------------------------
-- SUBMISSIONS: the actual data captured from forms or chat
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS it_onboarding_submissions (
    id                SERIAL       PRIMARY KEY,
    employee_id       VARCHAR(20)  NOT NULL REFERENCES employees(employee_id),
    laptop_preference VARCHAR(20)  NOT NULL,        -- Mac | HP | Dell
    work_number       VARCHAR(50),
    emergency_contact VARCHAR(50),
    cost_center       VARCHAR(50),
    drop_destination  TEXT,                          -- captured in chat path
    submitted_at      TIMESTAMPTZ  DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS hr_profile_submissions (
    id           SERIAL       PRIMARY KEY,
    employee_id  VARCHAR(20)  NOT NULL REFERENCES employees(employee_id),
    pan_number   TEXT,                               -- pgp_sym_encrypt encrypted
    bank_name    VARCHAR(100),
    bank_account TEXT,                               -- pgp_sym_encrypt encrypted
    ifsc_code    TEXT,                               -- pgp_sym_encrypt encrypted
    tax_regime   VARCHAR(20),                        -- OLD | NEW
    submitted_at TIMESTAMPTZ  DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS access_requests (
    id                SERIAL       PRIMARY KEY,
    employee_id       VARCHAR(20)  NOT NULL REFERENCES employees(employee_id),
    github_username   VARCHAR(100),
    slack_display_name VARCHAR(100),
    additional_tools  TEXT,                          -- comma-separated: Figma,Jira,Camtasia
    submitted_at      TIMESTAMPTZ  DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS document_acceptances (
    id            SERIAL       PRIMARY KEY,
    employee_id   VARCHAR(20)  NOT NULL REFERENCES employees(employee_id),
    document_type VARCHAR(50)  NOT NULL,   -- CONTRACT | CODE_OF_CONDUCT | COMPLIANCE_TRAINING
    accepted      BOOLEAN      DEFAULT FALSE,
    accepted_at   TIMESTAMPTZ,
    UNIQUE(employee_id, document_type)
);

CREATE TABLE IF NOT EXISTS connect_meetings (
    id              SERIAL       PRIMARY KEY,
    employee_id     VARCHAR(20)  NOT NULL REFERENCES employees(employee_id),
    meeting_type    VARCHAR(30)  NOT NULL,   -- MANAGER_INTRO | BUDDY_MEET | TOWNHALL
    preferred_dates TEXT,                    -- CSV of dates offered by employee
    booked_slot     TIMESTAMPTZ,
    booked_with     VARCHAR(200),            -- manager / buddy name
    agenda          TEXT,
    status          VARCHAR(20)  DEFAULT 'pending',  -- pending | booked | completed
    created_at      TIMESTAMPTZ  DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_meetings_emp ON connect_meetings(employee_id);

-- -----------------------------------------------------------------------------
-- ADMIN: editable prompt + tool registry (the prompt-as-business-process story)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS admin_prompts (
    id            SERIAL       PRIMARY KEY,
    event_code    VARCHAR(30)  NOT NULL REFERENCES events(event_code),
    prompt_text   TEXT         NOT NULL,
    version       INTEGER      DEFAULT 1,
    is_active     BOOLEAN      DEFAULT TRUE,
    updated_by    VARCHAR(100) DEFAULT 'admin',
    updated_at    TIMESTAMPTZ  DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_admin_prompts_event ON admin_prompts(event_code, is_active);

-- Tool registry — the MCP server reads this and exposes each active row as a tool
-- to the agent. Adding a row here (via admin UI) adds a new capability with no
-- redeploy. This is the demo climax.
CREATE TABLE IF NOT EXISTS admin_tools (
    id             SERIAL       PRIMARY KEY,
    tool_name      VARCHAR(100) UNIQUE NOT NULL,     -- snake_case, what LLM calls
    display_name   VARCHAR(200) NOT NULL,
    description    TEXT         NOT NULL,            -- written FOR the LLM
    input_schema   JSONB        NOT NULL,            -- JSON schema for tool args
    endpoint_url   VARCHAR(500) NOT NULL,            -- which microservice to call
    http_method    VARCHAR(10)  DEFAULT 'POST',
    event_code     VARCHAR(30)  REFERENCES events(event_code),
    is_active      BOOLEAN      DEFAULT TRUE,
    is_system      BOOLEAN      DEFAULT FALSE,       -- TRUE = built-in, FALSE = admin-added
    linked_task_code VARCHAR(50),                    -- task_code in event_tasks this tool backs
    created_at     TIMESTAMPTZ  DEFAULT NOW(),
    updated_at     TIMESTAMPTZ  DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_admin_tools_event ON admin_tools(event_code, is_active);

-- -----------------------------------------------------------------------------
-- ANNOUNCEMENT QUEUE: the runtime-added-tool backing store.
-- After the admin registers "send_joiner_announcement" in admin_tools, invocations
-- of that tool land here as queued email records. A batch/trigger job (out of
-- scope for this use case) would later push these into a real mail system.
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS announcement_queue (
    id              SERIAL       PRIMARY KEY,
    employee_id     VARCHAR(20)  REFERENCES employees(employee_id),
    recipient_list  TEXT         NOT NULL,      -- CSV of emails / distribution lists
    subject         VARCHAR(500) NOT NULL,
    body            TEXT         NOT NULL,
    status          VARCHAR(20)  DEFAULT 'queued',   -- queued | sent | failed
    created_at      TIMESTAMPTZ  DEFAULT NOW(),
    sent_at         TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_announcements_status ON announcement_queue(status);

-- -----------------------------------------------------------------------------
-- CONVERSATION TRACE (for observability — matches UC1 trace story)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS agent_traces (
    id            SERIAL       PRIMARY KEY,
    employee_id   VARCHAR(20),
    session_id    VARCHAR(100),
    turn_number   INTEGER,
    role          VARCHAR(20),                    -- user | assistant | tool
    content       TEXT,
    tool_name     VARCHAR(100),
    tool_input    JSONB,
    tool_output   JSONB,
    latency_ms    INTEGER,
    model         VARCHAR(50),
    created_at    TIMESTAMPTZ  DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_traces_session ON agent_traces(session_id, turn_number);
