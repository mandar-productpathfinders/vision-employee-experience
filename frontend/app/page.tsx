"use client";

import { useEffect, useRef, useState } from "react";

// -------- Config ------------------------------------------------------------

const AGENT_URL =
  process.env.NEXT_PUBLIC_AGENT_URL || "http://localhost:8200";
const HRMS_URL =
  process.env.NEXT_PUBLIC_HRMS_API_URL || "http://localhost:8101";
const ONBOARDING_URL =
  process.env.NEXT_PUBLIC_ONBOARDING_API_URL || "http://localhost:8102";
const ACCESS_URL =
  process.env.NEXT_PUBLIC_ACCESS_API_URL || "http://localhost:8103";
const DOCS_URL =
  process.env.NEXT_PUBLIC_DOCS_API_URL || "http://localhost:8104";
const CAL_URL =
  process.env.NEXT_PUBLIC_CAL_API_URL || "http://localhost:8105";

// -------- Types -------------------------------------------------------------

type Employee = {
  employee_id: string;
  full_name: string;
  email: string;
  designation?: string;
  department?: string;
};

type EventRow = {
  event_code: string;
  display_name: string;
  status: string;
};

type Task = {
  task_code: string;
  display_name: string;
  category: string;
  description: string;
  status: string;
};

type ChatBubble = {
  role: "user" | "assistant";
  text: string;
};

type TraceEntry = {
  tool: string;
  input: any;
  ok: boolean;
  latency_ms: number;
  result: any;
};

// -------- Task due-day lookup (no due_date in DB; defined here for display) --

const TASK_DUE_DAYS: Record<string, string> = {
  JJ_IT_ONBOARDING:       "By Day 1",
  JJ_ACCESS_REQUEST:      "By Day 1",
  JJ_HR_PROFILE:          "By Day 3",
  JJ_CONTRACT:            "By Day 3",
  JJ_CODE_OF_CONDUCT:     "By Day 7",
  JJ_MANAGER_INTRO:       "By Day 7",
  JJ_BUDDY_MEET:          "By Day 14",
  JJ_COMPLIANCE_TRAINING: "By Day 30",
  JJ_TOWNHALL:            "By Day 30",
};

// -------- Events panel ------------------------------------------------------

const ALL_EVENTS = [
  { code: "JUST_JOINED",    label: "Just Joined",      demoReady: true  },
  { code: "TRAVEL",         label: "Travel",           demoReady: false },
  { code: "PROMOTION",      label: "Promotion",        demoReady: false },
  { code: "YEAR_END",       label: "Year-End",         demoReady: false },
  { code: "PARENTAL_LEAVE", label: "Parental Leave",   demoReady: false },
];

// -------- Page --------------------------------------------------------------

export default function EmployeePortal() {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [employeeId, setEmployeeId] = useState<string>("");
  const [activeEvents, setActiveEvents] = useState<EventRow[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);

  // Chat state
  const [chat, setChat] = useState<ChatBubble[]>([]);
  const [apiMessages, setApiMessages] = useState<any[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [trace, setTrace] = useState<TraceEntry[]>([]);
  const [modelInfo, setModelInfo] = useState<{
    model?: string;
    provider?: string;
    prompt_version?: number;
    tool_count?: number;
  }>({});
  const [showFormModal, setShowFormModal] = useState(false);
  const [formModalConfig, setFormModalConfig] = useState<{ initialStep: 1 | 2; initialSelected: string[] }>({ initialStep: 1, initialSelected: [] });
  const [showTrace, setShowTrace] = useState(false);

  const chatBottomRef = useRef<HTMLDivElement | null>(null);

  // Load employees on mount
  useEffect(() => {
    fetch(`${HRMS_URL}/employees`)
      .then((r) => r.json())
      .then((rows) => {
        setEmployees(rows);
        if (rows.length && !employeeId) setEmployeeId(rows[0].employee_id);
      })
      .catch(console.error);
  }, []);

  // When employee changes, load their events + tasks and reset chat
  useEffect(() => {
    if (!employeeId) return;
    refreshEmployeeData();
    setChat([]);
    setApiMessages([]);
    setTrace([]);
    setModelInfo({});
  }, [employeeId]);

  useEffect(() => {
    chatBottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chat, sending]);

  function refreshEmployeeData() {
    if (!employeeId) return;
    fetch(`${HRMS_URL}/events?employee_id=${employeeId}`)
      .then((r) => r.json())
      .then(setActiveEvents)
      .catch(() => setActiveEvents([]));
    fetch(`${HRMS_URL}/tasks?employee_id=${employeeId}`)
      .then((r) => (r.ok ? r.json() : []))
      .then(setTasks)
      .catch(() => setTasks([]));
  }

  async function sendMessage(text?: string) {
    const toSend = (text ?? input).trim();
    if (!toSend || !employeeId) return;

    const userBubble: ChatBubble = { role: "user", text: toSend };
    const updatedChat = [...chat, userBubble];
    setChat(updatedChat);
    setInput("");
    setSending(true);

    const newApiMessages = [
      ...apiMessages,
      { role: "user", content: toSend },
    ];

    try {
      const resp = await fetch(`${AGENT_URL}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          employee_id: employeeId,
          event_code: "JUST_JOINED",
          messages: newApiMessages,
        }),
      });
      const data = await resp.json();

      if (data.error) {
        setChat([...updatedChat, { role: "assistant", text: `[agent error] ${data.error}` }]);
        setSending(false);
        return;
      }

      let assistantText = (data.reply || "").trim() || "(no reply)";

      // Detect form tokens and open the appropriate modal config
      const hasFullFormToken = /FORM:JUST_JOINED/i.test(assistantText);
      const hasHRFormToken   = /FORM:JJ_HR_PROFILE/i.test(assistantText);
      const hasFormToken = hasFullFormToken || hasHRFormToken;

      if (hasFullFormToken) {
        assistantText = assistantText.replace(/FORM:JUST_JOINED/gi, "").trim();
        if (!assistantText) assistantText = "I can open the onboarding form so you can fill everything in one go.";
        setFormModalConfig({ initialStep: 1, initialSelected: [] });
      } else if (hasHRFormToken) {
        assistantText = assistantText.replace(/FORM:JJ_HR_PROFILE/gi, "").trim();
        if (!assistantText) assistantText = "Opening the secure HR profile form for you.";
        setFormModalConfig({ initialStep: 2, initialSelected: ["JJ_HR_PROFILE"] });
      }

      setChat([...updatedChat, { role: "assistant", text: assistantText }]);
      setApiMessages(data.messages || []);
      setTrace(data.trace || []);
      setModelInfo({
        model: data.model,
        provider: data.provider,
        prompt_version: data.prompt_version,
        tool_count: data.tool_count,
      });
      if (hasFormToken) setShowFormModal(true);
      refreshEmployeeData();
    } catch (e: any) {
      setChat([
        ...updatedChat,
        { role: "assistant", text: `[error] ${e.message}` },
      ]);
    } finally {
      setSending(false);
    }
  }

  async function onEventClick(code: string, demoReady: boolean) {
    if (!demoReady) {
      alert(`${code} is not yet enabled in this demo build.`);
      return;
    }
    setShowFormModal(true);
  }

  const selectedEmployee = employees.find((e) => e.employee_id === employeeId);

  return (
    <main style={{ display: "flex", height: "calc(100vh - 56px)" }}>
      {/* ---- Chat pane (left) ---- */}
      <section
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          borderRight: "1px solid var(--border)",
          background: "white",
        }}
      >
        <EmployeePicker
          employees={employees}
          employeeId={employeeId}
          setEmployeeId={setEmployeeId}
          selected={selectedEmployee}
        />

        <div
          style={{
            flex: 1,
            overflowY: "auto",
            padding: "16px 20px",
            background: "#fafbfc",
          }}
        >
          {chat.length === 0 ? (
            <WelcomeHint employee={selectedEmployee} onQuick={sendMessage} hasActiveEvent={activeEvents.length > 0} />
          ) : (
            chat.map((b, i) => <Bubble key={i} bubble={b} />)
          )}
          {sending && (
            <div className="small muted" style={{ padding: "4px 12px" }}>
              Thinking…
            </div>
          )}
          <div ref={chatBottomRef} />
        </div>

        <ChatInput
          input={input}
          setInput={setInput}
          sending={sending}
          onSend={() => sendMessage()}
          modelInfo={modelInfo}
          onToggleTrace={() => setShowTrace(!showTrace)}
          traceCount={trace.length}
        />

        {showTrace && <TracePanel trace={trace} />}
      </section>

      {/* ---- Right pane: events + tasks ---- */}
      <aside
        style={{
          width: 360,
          background: "white",
          overflowY: "auto",
          padding: 16,
        }}
      >
        <h3 style={{ marginTop: 0 }}>Employee Events</h3>
        <p className="small muted" style={{ marginTop: -4 }}>
          Pick an event to open its form, or chat on the left to get going.
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {ALL_EVENTS.map((ev) => {
            const isActive = activeEvents.some(
              (ae) => ae.event_code === ev.code
            );
            const highlightComingSoon =
              activeEvents.length === 0 && ev.code === "TRAVEL";
            return (
              <EventCard
                key={ev.code}
                label={ev.label}
                code={ev.code}
                demoReady={ev.demoReady}
                activeForEmp={isActive}
                highlightComingSoon={highlightComingSoon}
                onClick={() => onEventClick(ev.code, ev.demoReady)}
              />
            );
          })}
        </div>

        <h3 style={{ marginTop: 24 }}>
          {activeEvents.length > 0 ? "Onboarding Tasks" : "Travel Tasks"}
          {activeEvents.length === 0 && (
            <span className="pill gray" style={{ marginLeft: 8, verticalAlign: "middle" }}>
              Coming soon
            </span>
          )}
        </h3>
        {activeEvents.length > 0 ? (
          <TaskList tasks={tasks} />
        ) : (
          <div className="small muted">Travel tasks are coming soon.</div>
        )}
      </aside>

      {showFormModal && employeeId && (
        <OnboardingFormModal
          employeeId={employeeId}
          tasks={tasks}
          onClose={() => setShowFormModal(false)}
          onCompleted={refreshEmployeeData}
          initialStep={formModalConfig.initialStep}
          initialSelected={formModalConfig.initialSelected}
        />
      )}
    </main>
  );
}

// -------- Subcomponents -----------------------------------------------------

function EmployeePicker({
  employees,
  employeeId,
  setEmployeeId,
  selected,
}: {
  employees: Employee[];
  employeeId: string;
  setEmployeeId: (s: string) => void;
  selected?: Employee;
}) {
  return (
    <div
      style={{
        padding: "12px 20px",
        borderBottom: "1px solid var(--border)",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
      }}
    >
      <div>
        <div className="small muted">Signed in as</div>
        <div style={{ fontWeight: 600 }}>
          {selected ? `${selected.full_name} · ${selected.designation || ""}` : "—"}
        </div>
      </div>
      <select
        style={{ maxWidth: 260 }}
        value={employeeId}
        onChange={(e) => setEmployeeId(e.target.value)}
      >
        {employees.map((e) => (
          <option key={e.employee_id} value={e.employee_id}>
            {e.employee_id} — {e.full_name}
          </option>
        ))}
      </select>
    </div>
  );
}

function WelcomeHint({
  employee,
  onQuick,
  hasActiveEvent,
}: {
  employee?: Employee;
  onQuick: (s: string) => void;
  hasActiveEvent: boolean;
}) {
  return (
    <div className="card" style={{ maxWidth: 620 }}>
      <h3 style={{ marginTop: 0 }}>
        Hi{employee ? `, ${employee.full_name.split(" ")[0]}` : ""} 👋
      </h3>
      {hasActiveEvent ? (
        <>
          <p className="muted" style={{ marginTop: 0 }}>
            I&apos;m the Vision Enterprise Onboarding Assistant. Ask me anything, or
            try one of these:
          </p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {[
              "I need a laptop.",
              "What do I still have to complete?",
              "Set up my GitHub and Slack access.",
              "Book my intro meeting with my manager.",
            ].map((q) => (
              <button key={q} onClick={() => onQuick(q)}>
                {q}
              </button>
            ))}
          </div>
        </>
      ) : (
        <>
          <p className="muted" style={{ marginTop: 0 }}>
            How can I help you today?
          </p>
          <div className="small muted" style={{ marginBottom: 8 }}>
            Travel assistance — coming soon:
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {[
              "I want to travel tomorrow.",
              "What are all tasks I need to complete for my travel?",
              "Book my hotel.",
              "Share feedback on my travel experience.",
            ].map((q) => (
              <button
                key={q}
                disabled
                style={{ opacity: 0.45, cursor: "not-allowed" }}
              >
                {q}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function Bubble({ bubble }: { bubble: ChatBubble }) {
  const isUser = bubble.role === "user";
  return (
    <div
      style={{
        display: "flex",
        justifyContent: isUser ? "flex-end" : "flex-start",
        margin: "8px 0",
      }}
    >
      <div
        style={{
          maxWidth: "78%",
          padding: "10px 14px",
          borderRadius: 12,
          background: isUser ? "var(--brand)" : "white",
          color: isUser ? "white" : "var(--text)",
          border: isUser ? "none" : "1px solid var(--border)",
          whiteSpace: "pre-wrap",
        }}
      >
        {bubble.text}
      </div>
    </div>
  );
}

function ChatInput({
  input,
  setInput,
  sending,
  onSend,
  modelInfo,
  onToggleTrace,
  traceCount,
}: any) {
  return (
    <div
      style={{
        borderTop: "1px solid var(--border)",
        padding: 12,
        background: "white",
      }}
    >
      <div style={{ display: "flex", gap: 8 }}>
        <textarea
          rows={2}
          value={input}
          placeholder="Type your message… (Enter to send, Shift+Enter for newline)"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              onSend();
            }
          }}
          disabled={sending}
        />
        <button className="primary" onClick={onSend} disabled={sending || !input.trim()}>
          Send
        </button>
      </div>
      <div
        className="small muted"
        style={{
          marginTop: 6,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <span>
          {modelInfo.provider ? (
            <>
              provider: <strong>{modelInfo.provider}</strong> · model:{" "}
              <strong>{modelInfo.model}</strong> · prompt v
              {modelInfo.prompt_version} · {modelInfo.tool_count} tools
            </>
          ) : (
            "Ready."
          )}
        </span>
        <button onClick={onToggleTrace}>Trace ({traceCount})</button>
      </div>
    </div>
  );
}

function TracePanel({ trace }: { trace: TraceEntry[] }) {
  return (
    <div
      style={{
        borderTop: "1px solid var(--border)",
        background: "var(--code-bg)",
        color: "var(--code-text)",
        padding: 12,
        maxHeight: 260,
        overflowY: "auto",
        fontFamily:
          'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
        fontSize: 12,
      }}
    >
      {trace.length === 0 ? (
        <div style={{ opacity: 0.6 }}>No tool calls yet.</div>
      ) : (
        trace.map((t, i) => (
          <div
            key={i}
            style={{
              padding: "6px 0",
              borderBottom: "1px solid rgba(255,255,255,0.08)",
            }}
          >
            <div>
              <span style={{ color: t.ok ? "#86efac" : "#fca5a5" }}>
                {t.ok ? "✓" : "✗"}
              </span>{" "}
              <strong>{t.tool}</strong>{" "}
              <span style={{ opacity: 0.6 }}>({t.latency_ms} ms)</span>
            </div>
            <div style={{ opacity: 0.75 }}>
              input: {JSON.stringify(t.input)}
            </div>
            <div style={{ opacity: 0.65 }}>
              result: {JSON.stringify(t.result).slice(0, 260)}
              {JSON.stringify(t.result).length > 260 ? "…" : ""}
            </div>
          </div>
        ))
      )}
    </div>
  );
}

function EventCard({
  label,
  code,
  demoReady,
  activeForEmp,
  highlightComingSoon,
  onClick,
}: {
  label: string;
  code: string;
  demoReady: boolean;
  activeForEmp: boolean;
  highlightComingSoon?: boolean;
  onClick: () => void;
}) {
  if (highlightComingSoon) {
    return (
      <div
        style={{
          border: "1px solid #93c5fd",
          borderRadius: 8,
          padding: "10px 12px",
          background: "#eff6ff",
          cursor: "default",
          position: "relative",
          overflow: "hidden",
        }}
      >
        <div style={{ filter: "blur(2px)", userSelect: "none" }}>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <strong>{label}</strong>
          </div>
          <div className="small muted">{code}</div>
        </div>
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
            padding: "0 12px",
          }}
        >
          <span className="pill gray">Coming soon</span>
        </div>
      </div>
    );
  }

  return (
    <div
      onClick={onClick}
      style={{
        border: "1px solid var(--border)",
        borderRadius: 8,
        padding: "10px 12px",
        cursor: demoReady ? "pointer" : "not-allowed",
        opacity: demoReady ? 1 : 0.55,
        background: activeForEmp ? "#eef2ff" : "white",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <strong>{label}</strong>
        {activeForEmp && <span className="pill">Active</span>}
        {!demoReady && <span className="pill gray">Coming soon</span>}
      </div>
      <div className="small muted">{code}</div>
    </div>
  );
}

function TaskList({ tasks }: { tasks: Task[] }) {
  if (!tasks.length) {
    return (
      <div className="small muted">
        No onboarding tasks for this employee.
      </div>
    );
  }
  const grouped: Record<string, Task[]> = {};
  for (const t of tasks) {
    if (!grouped[t.category]) grouped[t.category] = [];
    grouped[t.category].push(t);
  }
  const catLabel: Record<string, string> = {
    SYSTEM: "System Activities",
    DOCUMENT: "Documents",
    CONNECT: "Connect Meetings",
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {["SYSTEM", "DOCUMENT", "CONNECT"].map((cat) =>
        grouped[cat] ? (
          <div key={cat}>
            <div className="small muted" style={{ marginBottom: 4 }}>
              {catLabel[cat]}
            </div>
            {grouped[cat].map((t) => (
              <div
                key={t.task_code}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  padding: "6px 0",
                  borderBottom: "1px dashed #eef2f6",
                }}
              >
                <span style={{ fontSize: 13 }}>{t.display_name}</span>
                <span
                  className={
                    "pill " + (t.status === "completed" ? "green" : "amber")
                  }
                >
                  {t.status}
                </span>
              </div>
            ))}
          </div>
        ) : null
      )}
    </div>
  );
}

// -------- Onboarding form (modal) — 2-step task wizard ----------------------

function OnboardingFormModal({
  employeeId,
  tasks,
  onClose,
  onCompleted,
  initialStep = 1,
  initialSelected = [],
}: {
  employeeId: string;
  tasks: Task[];
  onClose: () => void;
  onCompleted: () => void;
  initialStep?: 1 | 2;
  initialSelected?: string[];
}) {
  const [step, setStep] = useState<1 | 2>(initialStep);
  const [selected, setSelected] = useState<string[]>(initialSelected);

  function toggle(code: string) {
    setSelected((prev) =>
      prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code]
    );
  }

  const pendingCount = tasks.filter((t) => t.status !== "completed").length;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(16, 24, 40, 0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 100,
      }}
      onClick={onClose}
    >
      <div
        className="card"
        style={{
          width: 680,
          maxWidth: "94vw",
          maxHeight: "88vh",
          padding: 0,
          display: "flex",
          flexDirection: "column",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          style={{
            padding: "14px 18px",
            borderBottom: "1px solid var(--border)",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexShrink: 0,
          }}
        >
          <div>
            <strong>Just Joined — Onboarding</strong>
            <div className="small muted" style={{ marginTop: 2 }}>
              Step {step} of 2 &mdash;{" "}
              {step === 1 ? "Select tasks to complete" : "Complete selected tasks"}
            </div>
          </div>
          <button onClick={onClose}>✕ Close</button>
        </div>

        {/* Step indicator */}
        <div
          style={{
            display: "flex",
            gap: 0,
            borderBottom: "1px solid var(--border)",
            flexShrink: 0,
          }}
        >
          {(["Select tasks", "Complete tasks"] as const).map((label, idx) => (
            <div
              key={label}
              style={{
                flex: 1,
                padding: "8px 0",
                textAlign: "center",
                fontSize: 12,
                fontWeight: 600,
                color: step === idx + 1 ? "var(--brand)" : "var(--text-dim)",
                borderBottom: step === idx + 1 ? "2px solid var(--brand)" : "2px solid transparent",
              }}
            >
              {idx + 1}. {label}
            </div>
          ))}
        </div>

        {/* Body — scrollable */}
        <div style={{ flex: 1, overflowY: "auto", padding: 18 }}>
          {step === 1 ? (
            <TaskSelectionStep tasks={tasks} selected={selected} onToggle={toggle} />
          ) : (
            <TaskFormsStep
              tasks={tasks}
              selectedCodes={selected}
              employeeId={employeeId}
              onDone={onCompleted}
            />
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            padding: "12px 18px",
            borderTop: "1px solid var(--border)",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexShrink: 0,
          }}
        >
          <button onClick={step === 1 ? onClose : () => setStep(1)}>
            {step === 1 ? "Cancel" : "← Back to selection"}
          </button>
          {step === 1 && (
            <button
              className="primary"
              disabled={selected.length === 0}
              onClick={() => setStep(2)}
            >
              Next: Complete {selected.length} selected task{selected.length !== 1 ? "s" : ""} →
            </button>
          )}
          {step === 1 && pendingCount === 0 && (
            <span className="small muted">All tasks are already completed.</span>
          )}
        </div>
      </div>
    </div>
  );
}

// -------- Step 1: Task selection ---------------------------------------------

function TaskSelectionStep({
  tasks,
  selected,
  onToggle,
}: {
  tasks: Task[];
  selected: string[];
  onToggle: (code: string) => void;
}) {
  const catOrder: Array<Task["category"]> = ["DOCUMENT", "CONNECT", "SYSTEM"];
  const catLabel: Record<string, string> = {
    DOCUMENT: "Documents to Review & Sign",
    CONNECT:  "Connect Meetings to Schedule",
    SYSTEM:   "System Setup Tasks",
  };

  const grouped: Record<string, Task[]> = {};
  for (const t of tasks) {
    if (!grouped[t.category]) grouped[t.category] = [];
    grouped[t.category].push(t);
  }

  return (
    <div>
      <p className="small muted" style={{ marginTop: 0, lineHeight: 1.6 }}>
        Tick the tasks you want to complete in this session. Tasks already done
        are shown as completed and cannot be re-submitted.
      </p>
      {catOrder.filter((c) => grouped[c]?.length).map((cat) => (
        <div key={cat} style={{ marginBottom: 20 }}>
          <div
            style={{
              fontWeight: 700,
              fontSize: 11,
              textTransform: "uppercase",
              letterSpacing: "0.06em",
              color: "var(--text-dim)",
              marginBottom: 8,
            }}
          >
            {catLabel[cat]}
          </div>
          {grouped[cat].map((t) => {
            const done = t.status === "completed";
            const checked = done || selected.includes(t.task_code);
            return (
              <label
                key={t.task_code}
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 10,
                  padding: "10px 12px",
                  borderRadius: 8,
                  border: `1px solid ${
                    done
                      ? "#d1fae5"
                      : selected.includes(t.task_code)
                      ? "#c7d2fe"
                      : "var(--border)"
                  }`,
                  marginBottom: 8,
                  cursor: done ? "default" : "pointer",
                  background: done
                    ? "#f0fdf4"
                    : selected.includes(t.task_code)
                    ? "#eef2ff"
                    : "white",
                }}
              >
                <input
                  type="checkbox"
                  style={{ width: "auto", marginTop: 3, flexShrink: 0 }}
                  checked={checked}
                  disabled={done}
                  onChange={() => !done && onToggle(t.task_code)}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 500, fontSize: 13 }}>
                    {t.display_name}
                  </div>
                  <div className="small muted" style={{ marginTop: 2 }}>
                    {t.description}
                  </div>
                </div>
                <div
                  style={{
                    flexShrink: 0,
                    fontSize: 11,
                    fontWeight: 600,
                    padding: "2px 8px",
                    borderRadius: 999,
                    alignSelf: "center",
                    background: done ? "#d1fae5" : "#fef3c7",
                    color: done ? "#065f46" : "#92400e",
                    whiteSpace: "nowrap",
                  }}
                >
                  {done ? "✓ Completed" : (TASK_DUE_DAYS[t.task_code] || "Pending")}
                </div>
              </label>
            );
          })}
        </div>
      ))}
    </div>
  );
}

// -------- Step 2: Task forms -------------------------------------------------

function TaskFormsStep({
  tasks,
  selectedCodes,
  employeeId,
  onDone,
}: {
  tasks: Task[];
  selectedCodes: string[];
  employeeId: string;
  onDone: () => void;
}) {
  const [submittedCodes, setSubmittedCodes] = useState<string[]>([]);

  function markSubmitted(code: string) {
    setSubmittedCodes((prev) => [...prev, code]);
    onDone();
  }

  const selected = tasks.filter((t) => selectedCodes.includes(t.task_code));

  return (
    <div>
      <p className="small muted" style={{ marginTop: 0, lineHeight: 1.6 }}>
        Complete each task below. Submissions are saved immediately — you can
        close the modal at any time and return to finish the rest.
      </p>
      {selected.map((t, idx) => {
        const done = submittedCodes.includes(t.task_code);
        return (
          <div
            key={t.task_code}
            style={{
              marginBottom: 24,
              border: `1px solid ${done ? "#d1fae5" : "var(--border)"}`,
              borderRadius: 10,
              overflow: "hidden",
            }}
          >
            {/* Task header */}
            <div
              style={{
                padding: "10px 14px",
                background: done ? "#f0fdf4" : "#f9fafb",
                borderBottom: `1px solid ${done ? "#d1fae5" : "var(--border)"}`,
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <div>
                <strong style={{ fontSize: 14 }}>
                  {idx + 1}. {t.display_name}
                </strong>
                <div className="small muted" style={{ marginTop: 1 }}>
                  {TASK_DUE_DAYS[t.task_code] || ""}
                </div>
              </div>
              {done && <span className="pill green">Submitted ✓</span>}
            </div>
            {/* Task form body */}
            {!done && (
              <div style={{ padding: 14 }}>
                <TaskFormContent
                  task={t}
                  employeeId={employeeId}
                  onDone={() => markSubmitted(t.task_code)}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function TaskFormContent({
  task,
  employeeId,
  onDone,
}: {
  task: Task;
  employeeId: string;
  onDone: () => void;
}) {
  const DOC_MAP: Record<string, string> = {
    JJ_CONTRACT:            "CONTRACT",
    JJ_CODE_OF_CONDUCT:     "CODE_OF_CONDUCT",
    JJ_COMPLIANCE_TRAINING: "COMPLIANCE_TRAINING",
  };
  const MEET_MAP: Record<string, string> = {
    JJ_MANAGER_INTRO: "MANAGER_INTRO",
    JJ_BUDDY_MEET:    "BUDDY_MEET",
    JJ_TOWNHALL:      "TOWNHALL",
  };

  if (DOC_MAP[task.task_code]) {
    return (
      <DocumentAcceptForm
        employeeId={employeeId}
        docType={DOC_MAP[task.task_code]}
        onDone={onDone}
      />
    );
  }
  if (MEET_MAP[task.task_code]) {
    return (
      <MeetingBookForm
        employeeId={employeeId}
        meetingType={MEET_MAP[task.task_code]}
        onDone={onDone}
      />
    );
  }
  if (task.task_code === "JJ_IT_ONBOARDING")
    return <ITOnboardingForm employeeId={employeeId} onDone={onDone} />;
  if (task.task_code === "JJ_HR_PROFILE")
    return <HRProfileForm employeeId={employeeId} onDone={onDone} />;
  if (task.task_code === "JJ_ACCESS_REQUEST")
    return <AccessRequestForm employeeId={employeeId} onDone={onDone} />;
  return <div className="small muted">No form available for this task.</div>;
}

// -------- Document accept form -----------------------------------------------

const DOC_CONTENT: Record<string, string> = {
  CONTRACT:
    "I confirm that I have read, understood, and agree to all terms of my employment contract with Vision Enterprise, including compensation, benefits, role responsibilities, and the conditions governing my employment.",
  CODE_OF_CONDUCT:
    "I confirm that I have read and understood the Vision Enterprise Code of Conduct. I agree to uphold its principles: professional integrity, respect for all colleagues, confidentiality of company information, and compliance with all applicable laws and regulations.",
  COMPLIANCE_TRAINING:
    "I confirm that I have completed all mandatory compliance training modules and understand my obligations under Vision Enterprise's compliance policies, including data protection, anti-harassment, and information security requirements.",
};

function DocumentAcceptForm({
  employeeId,
  docType,
  onDone,
}: {
  employeeId: string;
  docType: string;
  onDone: () => void;
}) {
  const [accepted, setAccepted] = useState(false);
  const [status, setStatus] = useState("");

  async function submit() {
    setStatus("Submitting…");
    try {
      const r = await fetch(`${DOCS_URL}/accept`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ employee_id: employeeId, document_type: docType }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setStatus("Accepted and recorded.");
      onDone();
    } catch (e: any) {
      setStatus(`Error: ${e.message}`);
    }
  }

  return (
    <div>
      <div
        style={{
          background: "#f9fafb",
          border: "1px solid var(--border)",
          borderRadius: 8,
          padding: 14,
          fontSize: 13,
          lineHeight: 1.7,
          marginBottom: 12,
          color: "var(--text-dim)",
        }}
      >
        {DOC_CONTENT[docType] || "Please read the document carefully."}
      </div>
      <label
        style={{
          display: "flex",
          gap: 8,
          alignItems: "flex-start",
          cursor: "pointer",
          marginBottom: 12,
        }}
      >
        <input
          type="checkbox"
          style={{ width: "auto", marginTop: 3, flexShrink: 0 }}
          checked={accepted}
          onChange={(e) => setAccepted(e.target.checked)}
        />
        <span style={{ fontSize: 13 }}>
          I have read and acknowledge the above statement.
        </span>
      </label>
      <button className="primary" onClick={submit} disabled={!accepted}>
        Submit acceptance
      </button>
      {status && (
        <div className="small" style={{ marginTop: 8 }}>
          {status}
        </div>
      )}
    </div>
  );
}

// -------- Meeting booking form -----------------------------------------------

const MEET_DESCRIPTIONS: Record<string, string> = {
  MANAGER_INTRO:
    "A 45-minute session covering your role expectations, success criteria, team ways of working, and 30-60-90 day goals. Provide up to two preferred dates and your manager will confirm one.",
  BUDDY_MEET:
    "A casual 30-minute chat with your assigned buddy or mentor. They'll share team culture, unwritten norms, and tips for your first 30 days. Pick a date that suits you.",
  TOWNHALL:
    "The New Joiner Townhall is held every Friday at 4:00 PM. It covers org strategy, culture, values, and an open Q&A with leadership. Your slot will be auto-assigned to the next available Friday — just confirm below.",
};

function MeetingBookForm({
  employeeId,
  meetingType,
  onDone,
}: {
  employeeId: string;
  meetingType: string;
  onDone: () => void;
}) {
  const [date1, setDate1] = useState("");
  const [date2, setDate2] = useState("");
  const [status, setStatus] = useState("");
  const isTownhall = meetingType === "TOWNHALL";
  const today = new Date().toISOString().split("T")[0];

  async function submit() {
    setStatus("Booking…");
    try {
      const r = await fetch(`${CAL_URL}/book`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          employee_id: employeeId,
          meeting_type: meetingType,
          preferred_dates: isTownhall
            ? undefined
            : [date1, date2].filter(Boolean),
        }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      const slot = data.booked_slot
        ? new Date(data.booked_slot).toLocaleString("en-IN", {
            dateStyle: "long",
            timeStyle: "short",
          })
        : "your preferred date";
      const who = data.booked_with ? ` · with ${data.booked_with}` : "";
      setStatus(`Booked for ${slot}${who}.`);
      onDone();
    } catch (e: any) {
      setStatus(`Error: ${e.message}`);
    }
  }

  return (
    <div>
      <p className="small muted" style={{ marginTop: 0, lineHeight: 1.6 }}>
        {MEET_DESCRIPTIONS[meetingType]}
      </p>
      {!isTownhall && (
        <>
          <Field label="Preferred date — 1st choice">
            <input
              type="date"
              value={date1}
              min={today}
              onChange={(e) => setDate1(e.target.value)}
            />
          </Field>
          <Field label="Preferred date — 2nd choice (optional)">
            <input
              type="date"
              value={date2}
              min={today}
              onChange={(e) => setDate2(e.target.value)}
            />
          </Field>
        </>
      )}
      <button
        className="primary"
        onClick={submit}
        disabled={!isTownhall && !date1}
      >
        {isTownhall ? "Confirm my townhall slot" : "Request this meeting"}
      </button>
      {status && (
        <div className="small" style={{ marginTop: 8 }}>
          {status}
        </div>
      )}
    </div>
  );
}

function ITOnboardingForm({
  employeeId,
  onDone,
}: {
  employeeId: string;
  onDone: () => void;
}) {
  const [laptop, setLaptop] = useState("Mac");
  const [drop, setDrop] = useState("");
  const [status, setStatus] = useState("");

  async function submit() {
    setStatus("submitting…");
    try {
      const r = await fetch(`${ONBOARDING_URL}/it-onboarding`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          employee_id: employeeId,
          laptop_preference: laptop,
          drop_destination: drop,
        }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      setStatus(
        `Submitted. HRMS auto-filled: work_number=${data.auto_filled.work_number}, cost_center=${data.auto_filled.cost_center}.`
      );
      onDone();
    } catch (e: any) {
      setStatus(`Error: ${e.message}`);
    }
  }

  return (
    <>
      <p className="small muted" style={{ marginTop: 0 }}>
        Work number, emergency contact and cost centre are auto-filled from HRMS.
      </p>
      <Field label="Laptop preference">
        <select value={laptop} onChange={(e) => setLaptop(e.target.value)}>
          <option>Mac</option>
          <option>HP</option>
          <option>Dell</option>
        </select>
      </Field>
      <Field label="Drop destination">
        <input
          value={drop}
          onChange={(e) => setDrop(e.target.value)}
          placeholder="e.g. 14, Indiranagar, Bengaluru 560038"
        />
      </Field>
      <button className="primary" onClick={submit} disabled={!drop.trim()}>
        Submit
      </button>
      {status && (
        <div className="small" style={{ marginTop: 10 }}>
          {status}
        </div>
      )}
    </>
  );
}

function HRProfileForm({
  employeeId,
  onDone,
}: {
  employeeId: string;
  onDone: () => void;
}) {
  const [pan, setPan] = useState("");
  const [bank, setBank] = useState("");
  const [acc, setAcc] = useState("");
  const [ifsc, setIfsc] = useState("");
  const [regime, setRegime] = useState("NEW");
  const [status, setStatus] = useState("");

  async function submit() {
    setStatus("submitting…");
    try {
      const r = await fetch(`${ONBOARDING_URL}/hr-profile`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          employee_id: employeeId,
          pan_number: pan.trim().toUpperCase(),
          bank_name: bank.trim(),
          bank_account: acc.trim().replace(/\s/g, ""),
          ifsc_code: ifsc.trim().toUpperCase(),
          tax_regime: regime,
        }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => null);
        const detail = body?.detail;
        const msg = Array.isArray(detail)
          ? detail.map((d: any) => `${d.loc?.slice(-1)[0]}: ${d.msg}`).join("; ")
          : (typeof detail === "string" ? detail : `HTTP ${r.status}`);
        throw new Error(msg);
      }
      setStatus("Submitted.");
      onDone();
    } catch (e: any) {
      setStatus(`Error: ${e.message}`);
    }
  }

  return (
    <>
      <Field label="PAN"><input value={pan} onChange={(e) => setPan(e.target.value.toUpperCase())} placeholder="ABCDE1234F" /></Field>
      <Field label="Bank name"><input value={bank} onChange={(e) => setBank(e.target.value)} placeholder="State Bank of India" /></Field>
      <Field label="Account number"><input value={acc} onChange={(e) => setAcc(e.target.value.replace(/\s/g, ""))} placeholder="123456789012" /></Field>
      <Field label="IFSC"><input value={ifsc} onChange={(e) => setIfsc(e.target.value.toUpperCase())} placeholder="SBIN0001234" /></Field>
      <Field label="Tax regime">
        <select value={regime} onChange={(e) => setRegime(e.target.value)}>
          <option value="NEW">New</option>
          <option value="OLD">Old</option>
        </select>
      </Field>
      <button className="primary" onClick={submit} disabled={!pan || !acc || !ifsc || !bank}>
        Submit
      </button>
      {status && <div className="small" style={{ marginTop: 10 }}>{status}</div>}
    </>
  );
}

function AccessRequestForm({
  employeeId,
  onDone,
}: {
  employeeId: string;
  onDone: () => void;
}) {
  const [gh, setGh] = useState("");
  const [slack, setSlack] = useState("");
  const [tools, setTools] = useState<string[]>([]);
  const [status, setStatus] = useState("");

  function toggle(t: string) {
    setTools((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]));
  }

  async function submit() {
    setStatus("submitting…");
    try {
      const r = await fetch(`${ACCESS_URL}/access-request`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          employee_id: employeeId,
          github_username: gh,
          slack_display_name: slack,
          additional_tools: tools,
        }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setStatus("Access request submitted.");
      onDone();
    } catch (e: any) {
      setStatus(`Error: ${e.message}`);
    }
  }

  return (
    <>
      <Field label="GitHub username"><input value={gh} onChange={(e) => setGh(e.target.value)} /></Field>
      <Field label="Slack display name"><input value={slack} onChange={(e) => setSlack(e.target.value)} /></Field>
      <Field label="Additional tools">
        <div style={{ display: "flex", gap: 12 }}>
          {["Figma", "Jira", "Camtasia"].map((t) => (
            <label key={t} style={{ display: "flex", gap: 4, alignItems: "center" }}>
              <input
                type="checkbox"
                checked={tools.includes(t)}
                onChange={() => toggle(t)}
                style={{ width: "auto" }}
              />
              {t}
            </label>
          ))}
        </div>
      </Field>
      <button className="primary" onClick={submit}>Submit</button>
      {status && <div className="small" style={{ marginTop: 10 }}>{status}</div>}
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div className="small muted" style={{ marginBottom: 4 }}>
        {label}
      </div>
      {children}
    </div>
  );
}
