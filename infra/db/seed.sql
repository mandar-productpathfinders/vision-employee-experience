-- =============================================================================
-- Vision Enterprise  —  Use Case 2 seed data
-- =============================================================================

-- Events (only JUST_JOINED is demo-ready in v1) -------------------------------

INSERT INTO events (event_code, display_name, description, is_demo_ready, sort_order) VALUES
  ('ROUTER',          'Router (System)',  'System event backing the agent dispatcher prompt. Not assigned to employees.', FALSE, 0),
  ('JUST_JOINED',     'Just Joined',      'Complete onboarding tasks when you join Vision Enterprise.', TRUE,  1),
  ('TRAVEL',          'Travel',           'Plan and book an upcoming business trip.',                    FALSE, 2),
  ('PROMOTION',       'Promotion',        'Activities triggered when you are promoted.',                 FALSE, 3),
  ('YEAR_END',        'Year-End Activities','Annual activities: appraisals, tax, declarations.',         FALSE, 4),
  ('PARENTAL_LEAVE',  'Parental Leave',   'Maternity or paternity leave planning.',                      FALSE, 5)
ON CONFLICT (event_code) DO NOTHING;

-- Task catalogue for JUST_JOINED ---------------------------------------------

INSERT INTO event_tasks (task_code, event_code, category, display_name, description, sort_order) VALUES
  -- System activities
  ('JJ_IT_ONBOARDING',      'JUST_JOINED', 'SYSTEM',   'IT Onboarding Form',
   'Laptop preference, work number, emergency contact, cost centre code.', 10),
  ('JJ_HR_PROFILE',         'JUST_JOINED', 'SYSTEM',   'HR Profile Completion',
   'PAN, bank details, IFSC, tax regime preference.', 20),
  ('JJ_ACCESS_REQUEST',     'JUST_JOINED', 'SYSTEM',   'Access Request',
   'GitHub, Slack, and additional tools (Figma, Jira, Camtasia).', 30),
  -- Document activities
  ('JJ_CONTRACT',           'JUST_JOINED', 'DOCUMENT', 'Employee Contract Signing',
   'Review and sign your employment contract.', 40),
  ('JJ_CODE_OF_CONDUCT',    'JUST_JOINED', 'DOCUMENT', 'Code of Conduct Acceptance',
   'Read and accept the Vision Enterprise Code of Conduct.', 50),
  ('JJ_COMPLIANCE_TRAINING','JUST_JOINED', 'DOCUMENT', 'Compliance Training',
   'Complete and acknowledge the mandatory compliance modules.', 60),
  -- Connect activities
  ('JJ_MANAGER_INTRO',      'JUST_JOINED', 'CONNECT',  'Intro Meeting with Manager',
   'Role expectations, success criteria, 30-60-90 day goals.', 70),
  ('JJ_BUDDY_MEET',         'JUST_JOINED', 'CONNECT',  'Meet Your Buddy / Mentor',
   'Team culture, unwritten norms, tips for your first 30 days.', 80),
  ('JJ_TOWNHALL',           'JUST_JOINED', 'CONNECT',  'New Joiner Townhall',
   'Org strategy, vision, values, Q&A with leadership.', 90)
ON CONFLICT (task_code) DO NOTHING;

-- Employees ------------------------------------------------------------------

-- Arjun Kumar — new joiner, just started. Full task cascade triggers.
-- Note: his HRMS profile has work_number/emergency_contact/cost_center pre-filled
-- so the IT onboarding form can auto-populate those (per the prompt).
INSERT INTO employees (
    employee_id, full_name, email, gender, date_of_joining, manager_id, manager_name,
    department, designation, cost_center, work_number, emergency_contact, location
) VALUES
  ('E1001', 'Arjun Kumar',      'arjun.kumar@visionenterprise.com',      'Male',
   CURRENT_DATE - INTERVAL '2 days', 'E9001', 'Priya Nair',
   'Engineering', 'Software Engineer', 'CC-ENG-042', '+91-80-4000-1001', '+91-98765-00001', 'Bengaluru'),
  ('E1002', 'Vishwanath Rao',   'vishwanath.rao@visionenterprise.com',   'Male',
   CURRENT_DATE - INTERVAL '6 years', 'E9002', 'Kavita Menon',
   'Product',     'Senior Principal Engineer', 'CC-PRD-011', '+91-80-4000-1002', '+91-98765-00002', 'Bengaluru')
ON CONFLICT (employee_id) DO NOTHING;

-- Managers (minimal rows so FK chain is clean and meeting booking looks real) -
INSERT INTO employees (
    employee_id, full_name, email, gender, date_of_joining, department, designation, location
) VALUES
  ('E9001', 'Priya Nair',   'priya.nair@visionenterprise.com',   'Female',
   CURRENT_DATE - INTERVAL '4 years', 'Engineering', 'Engineering Manager', 'Bengaluru'),
  ('E9002', 'Kavita Menon', 'kavita.menon@visionenterprise.com', 'Female',
   CURRENT_DATE - INTERVAL '8 years', 'Product',     'Director of Product',  'Bengaluru')
ON CONFLICT (employee_id) DO NOTHING;

-- Event assignment -----------------------------------------------------------

-- Arjun is in JUST_JOINED. Vishy is NOT — this is the demo contrast.
INSERT INTO employee_events (employee_id, event_code, status) VALUES
  ('E1001', 'JUST_JOINED', 'active')
ON CONFLICT (employee_id, event_code) DO NOTHING;

-- Task status: Arjun has all 9 JUST_JOINED tasks pending ---------------------

INSERT INTO employee_task_status (employee_id, task_code, status)
SELECT 'E1001', task_code, 'pending'
FROM event_tasks
WHERE event_code = 'JUST_JOINED'
ON CONFLICT (employee_id, task_code) DO NOTHING;

-- Admin prompts — two-tier architecture:
--   ROUTER   : dispatcher that runs first on every turn (call profile, detect event, route)
--   JUST_JOINED : specialist sub-agent instructions for the onboarding flow
-- The agent loads BOTH and concatenates them into one system prompt.
-- Admin can edit each independently via the Admin Console.

INSERT INTO admin_prompts (event_code, prompt_text, version, is_active, updated_by) VALUES
('ROUTER',
$ROUTER_PROMPT$You are the Vision Enterprise Employee Experience Assistant.

STARTUP SEQUENCE — execute at the start of every conversation, before responding to the employee:
1. Call get_employee_profile with the employee_id to learn who you are talking to and load their HR profile.
2. Call list_employee_events to check which life-event is currently active for this employee.
3. Route based on the result:
   - JUST_JOINED is active → you are now the Onboarding Assistant. Follow the JUST_JOINED ONBOARDING instructions below.
   - No active event → help the employee as a general assistant. For standalone equipment requests (e.g. "I need a laptop"), ask for laptop_preference and drop_destination, then call submit_it_onboarding directly.

Perform the startup sequence silently. Do not narrate steps 1–3 to the employee.$ROUTER_PROMPT$,
1, TRUE, 'system-init')
ON CONFLICT DO NOTHING;

INSERT INTO admin_prompts (event_code, prompt_text, version, is_active, updated_by) VALUES
('JUST_JOINED',
$PROMPT$JUST_JOINED ONBOARDING ASSISTANT

The employee is a new joiner in the JUST_JOINED life-event. Guide them through completing all onboarding tasks.

TASK AWARENESS
- Call list_pending_tasks (with event_code=JUST_JOINED) to see which tasks remain.
- The tasks span three categories:
  SYSTEM   → JJ_IT_ONBOARDING, JJ_HR_PROFILE, JJ_ACCESS_REQUEST
  DOCUMENT → JJ_CONTRACT, JJ_CODE_OF_CONDUCT, JJ_COMPLIANCE_TRAINING
  CONNECT  → JJ_MANAGER_INTRO, JJ_BUDDY_MEET, JJ_TOWNHALL
- Each task has a sort_order and a category. Lower sort_order = higher priority within that category.

TASK SEQUENCING
- Always call list_pending_tasks before acting on any employee request.
- Sequencing is enforced WITHIN a category only. Tasks in different categories are independent tracks.
- When the employee requests a specific task:
    1. Identify its category (SYSTEM, DOCUMENT, or CONNECT).
    2. Among all pending tasks in that SAME category, find the one with the lowest sort_order.
    3. If the requested task is not that lowest-sort_order task in its category:
         a. Acknowledge the request warmly.
         b. Name the earliest pending task in that category and state it must be completed first.
         c. Offer two choices: (i) start that earlier task now, or (ii) open the full onboarding form (return token FORM:JUST_JOINED).
    4. If the requested task already has the lowest sort_order in its category, proceed directly.
- A pending DOCUMENT task never blocks a SYSTEM or CONNECT request, and vice versa.
- If the employee explicitly says "skip" or "do this first anyway", honour their choice and proceed without further challenge.

CONVERSATION RULES
- If the employee asks to do all tasks or has not named a specific one, return the token FORM:JUST_JOINED so the UI opens the onboarding form.
- Never ask for data already in their HRMS profile (work_number, emergency_contact, cost_center). Use profile values silently.
- Never invent PAN numbers, bank account details, or meeting times. Ask the employee for these.
- Always say which tool you are about to call (one sentence) before calling it.
- After a successful submission, call mark_task_complete with the correct task_code, then confirm in one line.

TOOL USAGE
- Tools are dynamic — the administrator may add new tools at runtime. Read each tool description on every turn.
- If send_joiner_announcement is available and the employee has completed most tasks, offer to announce their joining. Always confirm with the employee before calling it.

STYLE
- Warm, practical, concise. Short sentences. One question at a time.
- No emojis. No corporate jargon. Confirmations: "Done.", "Noted.", "Got it."
- When a task completes, confirm in one line and ask what they would like to do next.$PROMPT$,
1, TRUE, 'system-init')
ON CONFLICT DO NOTHING;

-- Initial MCP tool registry --------------------------------------------------
-- These rows are what the MCP server exposes to the agent. is_system=TRUE means
-- built-in (do not let admin delete). send_joiner_announcement is intentionally
-- LEFT OUT so the admin can add it live during the demo.

INSERT INTO admin_tools (tool_name, display_name, description, input_schema, endpoint_url, http_method, event_code, is_active, is_system) VALUES

('get_employee_profile',
 'Get Employee Profile',
 'Fetch the core HR profile for an employee: name, email, manager, department, designation, cost centre, work number, emergency contact. Call this at the start of every conversation to learn who you are helping.',
 '{"type":"object","properties":{"employee_id":{"type":"string","description":"The employee ID, e.g. E1001"}},"required":["employee_id"]}'::jsonb,
 'http://hrms-api:8101/profile', 'GET', NULL, TRUE, TRUE),

('list_employee_events',
 'List Employee Events',
 'Return the list of active life-events for the given employee (e.g. JUST_JOINED, TRAVEL). Use this to understand what context the employee is in before responding to a request.',
 '{"type":"object","properties":{"employee_id":{"type":"string"}},"required":["employee_id"]}'::jsonb,
 'http://hrms-api:8101/events', 'GET', NULL, TRUE, TRUE),

('list_pending_tasks',
 'List Pending Tasks',
 'Return the list of tasks still pending for an employee for a specific event. Use this to decide whether the employee has one task left or many.',
 '{"type":"object","properties":{"employee_id":{"type":"string"},"event_code":{"type":"string"}},"required":["employee_id","event_code"]}'::jsonb,
 'http://hrms-api:8101/tasks/pending', 'GET', NULL, TRUE, TRUE),

('submit_it_onboarding',
 'Submit IT Onboarding',
 'Record the employee''s IT onboarding request: laptop preference (Mac, HP, or Dell) and the drop destination. Work number, emergency contact and cost centre are taken from their HRMS profile automatically.',
 '{"type":"object","properties":{"employee_id":{"type":"string"},"laptop_preference":{"type":"string","enum":["Mac","HP","Dell"]},"drop_destination":{"type":"string"}},"required":["employee_id","laptop_preference","drop_destination"]}'::jsonb,
 'http://onboarding-api:8102/it-onboarding', 'POST', 'JUST_JOINED', TRUE, TRUE),

('submit_hr_profile',
 'Submit HR Profile',
 'Record the employee''s HR profile details: PAN number, bank name, bank account, IFSC code, and tax regime (OLD or NEW).',
 '{"type":"object","properties":{"employee_id":{"type":"string"},"pan_number":{"type":"string"},"bank_name":{"type":"string"},"bank_account":{"type":"string"},"ifsc_code":{"type":"string"},"tax_regime":{"type":"string","enum":["OLD","NEW"]}},"required":["employee_id","pan_number","bank_name","bank_account","ifsc_code","tax_regime"]}'::jsonb,
 'http://onboarding-api:8102/hr-profile', 'POST', 'JUST_JOINED', TRUE, TRUE),

('submit_access_request',
 'Submit Access Request',
 'Record the employee''s access requests for GitHub (username), Slack (display name) and a list of additional tools such as Figma, Jira or Camtasia.',
 '{"type":"object","properties":{"employee_id":{"type":"string"},"github_username":{"type":"string"},"slack_display_name":{"type":"string"},"additional_tools":{"type":"array","items":{"type":"string"}}},"required":["employee_id"]}'::jsonb,
 'http://access-api:8103/access-request', 'POST', 'JUST_JOINED', TRUE, TRUE),

('accept_document',
 'Accept Document',
 'Record the employee''s acceptance of a document. document_type must be one of: CONTRACT, CODE_OF_CONDUCT, COMPLIANCE_TRAINING.',
 '{"type":"object","properties":{"employee_id":{"type":"string"},"document_type":{"type":"string","enum":["CONTRACT","CODE_OF_CONDUCT","COMPLIANCE_TRAINING"]}},"required":["employee_id","document_type"]}'::jsonb,
 'http://documents-api:8104/accept', 'POST', 'JUST_JOINED', TRUE, TRUE),

('book_connect_meeting',
 'Book Connect Meeting',
 'Book one of the new-joiner connect meetings: MANAGER_INTRO, BUDDY_MEET, or TOWNHALL. Provide the employee''s preferred dates as an array of ISO date strings. Returns the booked slot.',
 '{"type":"object","properties":{"employee_id":{"type":"string"},"meeting_type":{"type":"string","enum":["MANAGER_INTRO","BUDDY_MEET","TOWNHALL"]},"preferred_dates":{"type":"array","items":{"type":"string"}}},"required":["employee_id","meeting_type"]}'::jsonb,
 'http://calendar-api:8105/book', 'POST', 'JUST_JOINED', TRUE, TRUE),

('mark_task_complete',
 'Mark Task Complete',
 'Mark a specific onboarding task as completed for an employee. Call this after you have successfully captured the data required for that task.',
 '{"type":"object","properties":{"employee_id":{"type":"string"},"task_code":{"type":"string"}},"required":["employee_id","task_code"]}'::jsonb,
 'http://hrms-api:8101/tasks/complete', 'POST', NULL, TRUE, TRUE)

ON CONFLICT (tool_name) DO NOTHING;
