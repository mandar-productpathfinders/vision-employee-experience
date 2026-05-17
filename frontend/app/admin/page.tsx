"use client";

import { useEffect, useState } from "react";

const ADMIN_URL =
  process.env.NEXT_PUBLIC_ADMIN_API_URL || "http://localhost:8106";
const MCP_URL = process.env.NEXT_PUBLIC_MCP_URL || "http://localhost:8100";

type Tool = {
  tool_name: string;
  display_name: string;
  description: string;
  input_schema: any;
  endpoint_url: string;
  http_method: string;
  event_code: string | null;
  is_active: boolean;
  is_system: boolean;
  linked_task_code: string | null;
  updated_at: string;
};

type EventTask = {
  task_code: string;
  event_code: string;
  category: string;
  display_name: string;
  description: string;
  sort_order: number;
};

export default function AdminConsole() {
  const [tab, setTab] = useState<"prompt" | "tools">("prompt");

  return (
    <main style={{ padding: 24, maxWidth: 1100, margin: "0 auto" }}>
      <h2 style={{ marginTop: 0 }}>Admin Console</h2>
      <p className="muted" style={{ marginTop: -8 }}>
        Edit the onboarding agent&apos;s behaviour without a code change. Changes take
        effect on the next conversation turn.
      </p>

      <div style={{ display: "flex", gap: 8, marginTop: 16, marginBottom: 16 }}>
        <button
          className={tab === "prompt" ? "primary" : ""}
          onClick={() => setTab("prompt")}
        >
          Prompt
        </button>
        <button
          className={tab === "tools" ? "primary" : ""}
          onClick={() => setTab("tools")}
        >
          Tool Registry
        </button>
      </div>

      {tab === "prompt" ? <PromptEditor /> : <ToolRegistry />}
    </main>
  );
}

// ---- Prompt Editor --------------------------------------------------------

function PromptEditor() {
  const [promptTab, setPromptTab] = useState<"router" | "just_joined">("router");

  return (
    <div>
      <div style={{ marginBottom: 12 }}>
        <p className="small muted" style={{ margin: "0 0 10px" }}>
          The agent uses two prompts combined: the <strong>Router</strong> handles
          startup (profile lookup + event detection + routing) and the{" "}
          <strong>JUST_JOINED</strong> prompt guides the onboarding specialist.
          Edit each independently — changes take effect on the next conversation turn.
        </p>
        <div style={{ display: "flex", gap: 6 }}>
          <button
            className={promptTab === "router" ? "primary" : ""}
            onClick={() => setPromptTab("router")}
          >
            Router (Dispatcher)
          </button>
          <button
            className={promptTab === "just_joined" ? "primary" : ""}
            onClick={() => setPromptTab("just_joined")}
          >
            JUST_JOINED Onboarding
          </button>
        </div>
      </div>

      {promptTab === "router" ? (
        <SinglePromptEditor
          eventCode="ROUTER"
          label="Router Prompt — startup sequence &amp; event routing"
          showTaskCatalogue={false}
        />
      ) : (
        <SinglePromptEditor
          eventCode="JUST_JOINED"
          label="JUST_JOINED Onboarding Prompt — task guidance &amp; conversation rules"
          showTaskCatalogue={true}
        />
      )}
    </div>
  );
}

function buildSyncedDraft(tasks: EventTask[], draft: string, eventCode: string): string {
  const byCategory: Record<string, string[]> = {};
  for (const t of [...tasks].sort((a, b) => a.sort_order - b.sort_order)) {
    const cat = t.category.toUpperCase();
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(t.task_code);
  }
  const catOrder = ["SYSTEM", "DOCUMENT", "CONNECT"];
  const presentCats = catOrder.filter((c) => byCategory[c]?.length);
  const otherCats = Object.keys(byCategory).filter((c) => !catOrder.includes(c));
  const allCats = [...presentCats, ...otherCats];
  const newBlock = [
    "TASK AWARENESS",
    `- Call list_pending_tasks (with event_code=${eventCode}) to see which tasks remain.`,
    `- The ${tasks.length} task${tasks.length === 1 ? "" : "s"} span ${allCats.length} ${allCats.length === 1 ? "category" : "categories"}:`,
    ...allCats.map((cat) => `  ${cat.padEnd(8)} → ${byCategory[cat].join(", ")}`),
  ].join("\n");
  const regex = /TASK AWARENESS[\s\S]*?(?=\n\n)/;
  if (regex.test(draft)) return draft.replace(regex, newBlock);
  return draft + "\n\n" + newBlock;
}

function SinglePromptEditor({
  eventCode,
  label,
  showTaskCatalogue,
}: {
  eventCode: string;
  label: string;
  showTaskCatalogue: boolean;
}) {
  const [prompt, setPrompt] = useState<any>(null);
  const [draft, setDraft] = useState<string>("");
  const [history, setHistory] = useState<any[]>([]);
  const [tasks, setTasks] = useState<EventTask[]>([]);
  const [status, setStatus] = useState("");

  useEffect(() => {
    setPrompt(null);
    setDraft("");
    setHistory([]);
    setStatus("");
    load();
  }, [eventCode]);

  async function load() {
    try {
      const p = await fetch(`${ADMIN_URL}/prompt/${eventCode}`).then((r) => r.json());
      setPrompt(p);
      setDraft(p.prompt_text);
    } catch {
      setStatus("Failed to load prompt.");
    }
    try {
      const h = await fetch(`${ADMIN_URL}/prompt-history/${eventCode}`).then((r) => r.json());
      setHistory(h);
    } catch {}
    if (showTaskCatalogue) {
      try {
        const t = await fetch(`${ADMIN_URL}/event-tasks?event_code=${eventCode}`).then((r) => r.json());
        setTasks(t);
      } catch {}
    }
  }

  async function save() {
    setStatus("saving…");
    const r = await fetch(`${ADMIN_URL}/prompt/${eventCode}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt_text: draft, updated_by: "admin" }),
    });
    if (r.ok) {
      setStatus("Saved. New version active.");
      load();
    } else {
      setStatus("Save failed.");
    }
  }

  function syncPrompt() {
    setDraft(buildSyncedDraft(tasks, draft, eventCode));
    setStatus("Task list synced into draft — save to persist.");
  }

  if (!prompt) return <div className="muted">Loading…</div>;

  const historyItems = (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {history.map((h) => (
        <div
          key={h.id}
          style={{
            padding: 8,
            border: "1px solid var(--border)",
            borderRadius: 6,
            background: h.is_active ? "#f0fdf4" : "white",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <strong>v{h.version}</strong>
            {h.is_active && <span className="pill green">active</span>}
          </div>
          <div className="small muted">by {h.updated_by} · {h.updated_at}</div>
          <div className="small" style={{ marginTop: 4, opacity: 0.8 }}>
            {h.preview}…
          </div>
        </div>
      ))}
    </div>
  );

  return (
    <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 16 }}>
      <div className="card">
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
          <strong dangerouslySetInnerHTML={{ __html: label + ` — v${prompt.version}` }} />
          <span className="small muted">updated {prompt.updated_at}</span>
        </div>
        <textarea
          rows={showTaskCatalogue ? 20 : 24}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          style={{ fontFamily: "ui-monospace, monospace", fontSize: 13 }}
        />
        <div style={{ display: "flex", gap: 8, marginTop: 10, alignItems: "center" }}>
          <button className="primary" onClick={save} disabled={draft === prompt.prompt_text}>
            Save new version
          </button>
          <button onClick={() => setDraft(prompt.prompt_text)}>Discard</button>
          {showTaskCatalogue && (
            <button
              onClick={syncPrompt}
              title="Update the TASK AWARENESS block in the prompt from the current task catalogue"
            >
              Sync prompt ↑
            </button>
          )}
          {status && <span className="small muted">{status}</span>}
        </div>
        {showTaskCatalogue && (
          <div style={{ marginTop: 16, borderTop: "1px solid var(--border)", paddingTop: 12 }}>
            <strong className="small">Version history</strong>
            <div style={{ marginTop: 6 }}>{historyItems}</div>
          </div>
        )}
      </div>

      {showTaskCatalogue ? (
        <TaskCataloguePanel eventCode={eventCode} tasks={tasks} onReload={load} />
      ) : (
        <div className="card">
          <strong>Version history</strong>
          <div style={{ marginTop: 8 }}>{historyItems}</div>
        </div>
      )}
    </div>
  );
}

// ---- Task Catalogue Panel -------------------------------------------------

function TaskCataloguePanel({
  eventCode,
  tasks,
  onReload,
}: {
  eventCode: string;
  tasks: EventTask[];
  onReload: () => void;
}) {
  const [showAddForm, setShowAddForm] = useState(false);
  const [prefillData, setPrefillData] = useState<{ displayName?: string; taskCode?: string; category?: string; description?: string } | null>(null);
  const [deleteStatus, setDeleteStatus] = useState<Record<string, string>>({});

  const ANNOUNCEMENT_PREFILL = {
    displayName: "Send Joiner Announcement",
    taskCode: "JJ_SEND_ANNOUNCEMENT",
    category: "CONNECT",
    description: "Send an email announcement to the organization introducing your joining to the team.",
  };
  const announcementTaskExists = tasks.some((t) => t.task_code === "JJ_SEND_ANNOUNCEMENT");

  const catOrder = ["SYSTEM", "DOCUMENT", "CONNECT"];
  const catLabel: Record<string, string> = {
    SYSTEM: "System Activities",
    DOCUMENT: "Documents",
    CONNECT: "Connect Meetings",
  };
  const grouped: Record<string, EventTask[]> = {};
  for (const t of tasks) {
    if (!grouped[t.category]) grouped[t.category] = [];
    grouped[t.category].push(t);
  }
  const cats = [
    ...catOrder.filter((c) => grouped[c]),
    ...Object.keys(grouped).filter((c) => !catOrder.includes(c)),
  ];

  async function deleteTask(taskCode: string) {
    if (!confirm(`Delete task ${taskCode}? This cannot be undone.`)) return;
    setDeleteStatus((s) => ({ ...s, [taskCode]: "deleting…" }));
    const r = await fetch(`${ADMIN_URL}/event-tasks/${taskCode}`, { method: "DELETE" });
    if (r.ok) {
      onReload();
    } else {
      const err = await r.json();
      setDeleteStatus((s) => ({ ...s, [taskCode]: err.detail ?? "Failed" }));
    }
  }

  async function moveTask(cat: string, idx: number, direction: "up" | "down") {
    const catTasks = [...(grouped[cat] ?? [])];
    const targetIdx = direction === "up" ? idx - 1 : idx + 1;
    if (targetIdx < 0 || targetIdx >= catTasks.length) return;
    // Swap positions then assign clean sequential sort_orders (10, 20, 30…)
    [catTasks[idx], catTasks[targetIdx]] = [catTasks[targetIdx], catTasks[idx]];
    await Promise.all(
      catTasks.map((t, i) =>
        fetch(`${ADMIN_URL}/event-tasks/${t.task_code}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sort_order: (i + 1) * 10 }),
        })
      )
    );
    onReload();
  }

  return (
    <div className="card" style={{ padding: 0, display: "flex", flexDirection: "column" }}>
      <div
        style={{
          padding: "12px 16px",
          borderBottom: "1px solid var(--border)",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <strong>Task Catalogue</strong>
        <span className="small muted">{tasks.length} tasks · ↑↓ reorders within category</span>
      </div>
      <div style={{ flex: 1, overflowY: "auto" }}>
        {cats.length === 0 && (
          <div className="small muted" style={{ padding: "12px 16px" }}>
            No tasks yet. Add one below.
          </div>
        )}
        {cats.map((cat) => (
          <div key={cat}>
            <div
              className="small"
              style={{
                padding: "5px 16px",
                background: "#f9fafb",
                borderBottom: "1px solid var(--border)",
                fontWeight: 600,
                color: "#475467",
              }}
            >
              {catLabel[cat] ?? cat}
            </div>
            {(grouped[cat] ?? []).map((t, idx) => (
              <div
                key={t.task_code}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "flex-start",
                  padding: "8px 16px",
                  borderBottom: "1px solid #f0f2f5",
                }}
              >
                <div>
                  <div style={{ fontSize: 13 }}>{t.display_name}</div>
                  <div className="small muted">{t.task_code}</div>
                  {deleteStatus[t.task_code] && (
                    <div className="small" style={{ color: "var(--red, #e53e3e)" }}>
                      {deleteStatus[t.task_code]}
                    </div>
                  )}
                </div>
                <div style={{ display: "flex", gap: 3, alignItems: "flex-start", marginTop: 2, flexShrink: 0 }}>
                  <button
                    style={{ fontSize: 11, padding: "2px 6px" }}
                    title="Move up within category"
                    disabled={idx === 0}
                    onClick={() => moveTask(cat, idx, "up")}
                  >
                    ↑
                  </button>
                  <button
                    style={{ fontSize: 11, padding: "2px 6px" }}
                    title="Move down within category"
                    disabled={idx === (grouped[cat].length - 1)}
                    onClick={() => moveTask(cat, idx, "down")}
                  >
                    ↓
                  </button>
                  <button
                    className="danger"
                    style={{ fontSize: 11, padding: "2px 8px" }}
                    onClick={() => deleteTask(t.task_code)}
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
      <div style={{ padding: "10px 16px", borderTop: "1px solid var(--border)" }}>
        {showAddForm ? (
          <AddTaskForm
            eventCode={eventCode}
            prefill={prefillData ?? undefined}
            onDone={() => { setShowAddForm(false); setPrefillData(null); onReload(); }}
            onCancel={() => { setShowAddForm(false); setPrefillData(null); }}
          />
        ) : (
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <button className="primary" onClick={() => setShowAddForm(true)}>
              + Add task
            </button>
            {!announcementTaskExists && (
              <button
                onClick={() => { setPrefillData(ANNOUNCEMENT_PREFILL); setShowAddForm(true); }}
                title="Pre-fill the form with Send Joiner Announcement task details"
              >
                Pre-fill: Joiner Announcement
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function AddTaskForm({
  eventCode,
  onDone,
  onCancel,
  prefill,
}: {
  eventCode: string;
  onDone: () => void;
  onCancel: () => void;
  prefill?: { displayName?: string; taskCode?: string; category?: string; description?: string };
}) {
  const [displayName, setDisplayName] = useState(prefill?.displayName ?? "");
  const [taskCode, setTaskCode] = useState(prefill?.taskCode ?? "");
  const [category, setCategory] = useState(prefill?.category ?? "CONNECT");
  const [description, setDescription] = useState(prefill?.description ?? "");
  const [registerTool, setRegisterTool] = useState(false);
  const [toolName, setToolName] = useState("");
  const [toolEndpoint, setToolEndpoint] = useState("");
  const [toolSchema, setToolSchema] = useState(
    JSON.stringify(
      { type: "object", properties: { employee_id: { type: "string" } }, required: ["employee_id"] },
      null,
      2
    )
  );
  const [status, setStatus] = useState("");

  useEffect(() => {
    if (displayName) {
      const prefix = eventCode.split("_").map((w) => w[0]).join("");
      const suffix = displayName.toUpperCase().replace(/\s+/g, "_").replace(/[^A-Z0-9_]/g, "");
      setTaskCode(`${prefix}_${suffix}`.slice(0, 50));
    }
  }, [displayName, eventCode]);

  useEffect(() => {
    if (taskCode) setToolName(taskCode.toLowerCase());
  }, [taskCode]);

  async function submit() {
    if (!displayName || !taskCode) { setStatus("Display name and task code are required."); return; }
    setStatus("creating…");
    const tr = await fetch(`${ADMIN_URL}/event-tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task_code: taskCode, event_code: eventCode, category, display_name: displayName, description }),
    });
    if (!tr.ok) {
      const err = await tr.json();
      setStatus(`Failed: ${err.detail ?? JSON.stringify(err)}`);
      return;
    }
    if (registerTool && toolName && toolEndpoint) {
      let parsedSchema;
      try { parsedSchema = JSON.parse(toolSchema); } catch (e: any) { setStatus(`Schema error: ${e.message}`); return; }
      const toolRes = await fetch(`${ADMIN_URL}/tools`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tool_name: toolName,
          display_name: displayName,
          description: description || `Execute the ${displayName} task.`,
          input_schema: parsedSchema,
          endpoint_url: toolEndpoint,
          http_method: "POST",
          event_code: eventCode,
          is_active: true,
          linked_task_code: taskCode,
        }),
      });
      if (!toolRes.ok) {
        const terr = await toolRes.json();
        setStatus(`Task created but tool failed: ${terr.detail ?? JSON.stringify(terr)}`);
        return;
      }
      await fetch(`${MCP_URL}/tools/reload`, { method: "POST" });
    }
    onDone();
  }

  return (
    <div>
      <div className="small muted" style={{ marginBottom: 8, fontWeight: 600 }}>New task</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <input
          placeholder="Display name *"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
        />
        <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 8 }}>
          <input
            placeholder="Task code *"
            value={taskCode}
            onChange={(e) => setTaskCode(e.target.value.toUpperCase())}
          />
          <select value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="CONNECT">CONNECT</option>
            <option value="SYSTEM">SYSTEM</option>
            <option value="DOCUMENT">DOCUMENT</option>
          </select>
        </div>
        <input
          placeholder="Description (optional)"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
          <input type="checkbox" checked={registerTool} onChange={(e) => setRegisterTool(e.target.checked)} />
          <span className="small">Also register a tool for this task</span>
        </label>
        {registerTool && (
          <div style={{ paddingLeft: 12, borderLeft: "2px solid var(--border)", display: "flex", flexDirection: "column", gap: 6 }}>
            <input placeholder="Tool name *" value={toolName} onChange={(e) => setToolName(e.target.value)} />
            <input placeholder="Endpoint URL *" value={toolEndpoint} onChange={(e) => setToolEndpoint(e.target.value)} />
            <textarea
              rows={4}
              value={toolSchema}
              onChange={(e) => setToolSchema(e.target.value)}
              style={{ fontFamily: "ui-monospace, monospace", fontSize: 11 }}
            />
          </div>
        )}
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button className="primary" onClick={submit} disabled={!displayName || !taskCode}>Create</button>
          <button onClick={onCancel}>Cancel</button>
          {status && <span className="small muted">{status}</span>}
        </div>
      </div>
    </div>
  );
}

// ---- Tool Registry --------------------------------------------------------

function ToolRegistry() {
  const [tools, setTools] = useState<Tool[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState<Tool | null>(null);
  const [mcpStatus, setMcpStatus] = useState<any>(null);
  const [deleteTarget, setDeleteTarget] = useState<Tool | null>(null);

  useEffect(() => { load(); const i = setInterval(load, 4000); return () => clearInterval(i); }, []);

  async function load() {
    const r = await fetch(`${ADMIN_URL}/tools?active_only=false`).then((x) => x.json());
    setTools(r);
    try {
      const m = await fetch(`${MCP_URL}/health`).then((x) => x.json());
      setMcpStatus(m);
    } catch {}
  }

  async function toggle(name: string) {
    await fetch(`${ADMIN_URL}/tools/${name}/toggle`, { method: "POST" });
    load();
  }

  async function forceReload() {
    await fetch(`${MCP_URL}/tools/reload`, { method: "POST" });
    load();
  }

  return (
    <>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 12,
        }}
      >
        <div className="small muted">
          MCP server: {mcpStatus?.tools_loaded ?? "?"} tools loaded ·
          last reload {mcpStatus?.last_reload_at ?? "—"}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={forceReload}>Force MCP reload</button>
          <button className="primary" onClick={() => setShowAdd(true)}>
            + Add tool
          </button>
          <button onClick={addAnnouncementTemplate}>
            + Add announcement tool (demo shortcut)
          </button>
        </div>
      </div>

      <div className="card" style={{ padding: 0 }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ background: "#f9fafb", textAlign: "left" }}>
              <th style={th}>Tool</th>
              <th style={th}>Description</th>
              <th style={th}>Endpoint</th>
              <th style={th}>Type</th>
              <th style={th}>Active</th>
              <th style={th}></th>
            </tr>
          </thead>
          <tbody>
            {tools.map((t) => (
              <tr key={t.tool_name} style={{ borderTop: "1px solid var(--border)" }}>
                <td style={td}>
                  <code>{t.tool_name}</code>
                  <div className="small muted">{t.display_name}</div>
                </td>
                <td style={{ ...td, maxWidth: 420 }}>
                  <div style={{ fontSize: 12, lineHeight: 1.4 }}>
                    {t.description.slice(0, 160)}
                    {t.description.length > 160 ? "…" : ""}
                  </div>
                </td>
                <td style={td}>
                  <div className="small">{t.http_method} {t.endpoint_url}</div>
                </td>
                <td style={td}>
                  {t.is_system ? (
                    <span className="pill gray">system</span>
                  ) : (
                    <span className="pill">custom</span>
                  )}
                </td>
                <td style={td}>
                  <span className={"pill " + (t.is_active ? "green" : "red")}>
                    {t.is_active ? "on" : "off"}
                  </span>
                </td>
                <td style={td}>
                  <div style={{ display: "flex", gap: 4 }}>
                    <button onClick={() => toggle(t.tool_name)}>
                      {t.is_active ? "Disable" : "Enable"}
                    </button>
                    {!t.is_system && (
                      <button className="danger" onClick={() => setDeleteTarget(t)}>
                        Delete
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showAdd && <AddToolModal onClose={() => setShowAdd(false)} onDone={load} />}
      {deleteTarget && (
        <DeleteToolModal
          tool={deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onDone={() => { setDeleteTarget(null); load(); }}
        />
      )}
    </>
  );

  async function addAnnouncementTemplate() {
    const toolBody = {
      tool_name: "send_joiner_announcement",
      display_name: "Send Joiner Announcement",
      description:
        "Send an email announcement to the organization introducing a new joiner. Use this after the employee has completed the bulk of their onboarding tasks. Provide the employee_id, the recipient_list (comma-separated email addresses or distribution lists like 'all-engineering@visionenterprise.com'), a subject line, and a short body introducing the new joiner by name, role, and team.",
      input_schema: {
        type: "object",
        properties: {
          employee_id: { type: "string" },
          recipient_list: {
            type: "string",
            description: "Comma-separated recipients",
          },
          subject: { type: "string" },
          body: { type: "string" },
        },
        required: ["employee_id", "recipient_list", "subject", "body"],
      },
      endpoint_url: "http://announcement-api:8107/send",
      http_method: "POST",
      event_code: "JUST_JOINED",
      is_active: true,
      linked_task_code: "JJ_SEND_ANNOUNCEMENT",
    };
    const r = await fetch(`${ADMIN_URL}/tools`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(toolBody),
    });
    if (!r.ok && r.status !== 409) {
      const err = await r.json();
      alert(`Failed to create tool: ${JSON.stringify(err)}`);
      return;
    }

    await fetch(`${MCP_URL}/tools/reload`, { method: "POST" });
    load();
    alert(`send_joiner_announcement tool added and MCP reloaded.\nNow go to the Prompt tab → JUST_JOINED → Task Catalogue and click "Pre-fill: Joiner Announcement" to add it as a task.`);
  }
}

function DeleteToolModal({
  tool,
  onClose,
  onDone,
}: {
  tool: Tool;
  onClose: () => void;
  onDone: () => void;
}) {
  const [status, setStatus] = useState("");

  async function doDelete(alsoDeleteTask: boolean) {
    setStatus("deleting…");
    if (alsoDeleteTask && tool.linked_task_code) {
      const tr = await fetch(`${ADMIN_URL}/event-tasks/${tool.linked_task_code}`, { method: "DELETE" });
      if (!tr.ok) {
        const err = await tr.json();
        setStatus(`Could not delete task: ${err.detail ?? JSON.stringify(err)}`);
        return;
      }
    }
    const r = await fetch(`${ADMIN_URL}/tools/${tool.tool_name}`, { method: "DELETE" });
    if (!r.ok) {
      const err = await r.json();
      setStatus(`Could not delete tool: ${err.detail ?? JSON.stringify(err)}`);
      return;
    }
    await fetch(`${MCP_URL}/tools/reload`, { method: "POST" });
    onDone();
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, background: "rgba(16,24,40,0.5)",
        display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="card"
        style={{ width: 480, maxWidth: "94vw", padding: 0 }}
      >
        <div style={{ padding: "12px 18px", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between" }}>
          <strong>Delete tool</strong>
          <button onClick={onClose}>Close</button>
        </div>
        <div style={{ padding: 18 }}>
          <p style={{ margin: "0 0 12px" }}>
            You are about to delete <code>{tool.tool_name}</code>.
          </p>

          {tool.linked_task_code ? (
            <>
              <div
                style={{
                  background: "#fffbeb", border: "1px solid #f59e0b",
                  borderRadius: 6, padding: "10px 14px", marginBottom: 16,
                }}
              >
                <strong className="small">This tool is linked to a task catalogue entry.</strong>
                <p className="small muted" style={{ margin: "4px 0 0" }}>
                  Task <strong>{tool.linked_task_code}</strong> in the{" "}
                  <strong>{tool.event_code}</strong> event catalogue uses this tool.
                  Deleting only the tool leaves the task visible to employees but
                  with no tool to execute it.
                </p>
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <button className="danger" onClick={() => doDelete(true)}>
                  Delete tool and task
                </button>
                <button onClick={() => doDelete(false)}>
                  Delete tool only
                </button>
                <button onClick={onClose}>Cancel</button>
                {status && <span className="small muted">{status}</span>}
              </div>
            </>
          ) : (
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <button className="danger" onClick={() => doDelete(false)}>
                Confirm delete
              </button>
              <button onClick={onClose}>Cancel</button>
              {status && <span className="small muted">{status}</span>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const th: React.CSSProperties = { padding: 10, fontWeight: 600, fontSize: 12, color: "#475467" };
const td: React.CSSProperties = { padding: 10, verticalAlign: "top" };

function AddToolModal({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: () => void;
}) {
  const [name, setName] = useState("");
  const [display, setDisplay] = useState("");
  const [desc, setDesc] = useState("");
  const [endpoint, setEndpoint] = useState("http://announcement-api:8107/send");
  const [method, setMethod] = useState("POST");
  const [schema, setSchema] = useState(
    JSON.stringify(
      {
        type: "object",
        properties: {
          employee_id: { type: "string" },
          recipient_list: { type: "string" },
          subject: { type: "string" },
          body: { type: "string" },
        },
        required: ["employee_id", "recipient_list", "subject", "body"],
      },
      null,
      2
    )
  );
  const [events, setEvents] = useState<{ event_code: string; display_name: string }[]>([]);
  const [eventCode, setEventCode] = useState("JUST_JOINED");
  const [createTask, setCreateTask] = useState(false);
  const [taskCode, setTaskCode] = useState("");
  const [taskCategory, setTaskCategory] = useState("CONNECT");
  const [taskDesc, setTaskDesc] = useState("");
  const [status, setStatus] = useState("");

  useEffect(() => {
    fetch(`${ADMIN_URL}/events`)
      .then((r) => r.json())
      .then(setEvents)
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (name) setTaskCode(name.toUpperCase());
  }, [name]);

  async function submit() {
    let parsedSchema;
    try {
      parsedSchema = JSON.parse(schema);
    } catch (e: any) {
      setStatus(`Schema JSON error: ${e.message}`);
      return;
    }
    setStatus("creating…");
    const r = await fetch(`${ADMIN_URL}/tools`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tool_name: name,
        display_name: display,
        description: desc,
        input_schema: parsedSchema,
        endpoint_url: endpoint,
        http_method: method,
        event_code: eventCode || null,
        is_active: true,
        linked_task_code: createTask && taskCode ? taskCode : null,
      }),
    });
    if (!r.ok) {
      const err = await r.json();
      setStatus(`Failed: ${JSON.stringify(err)}`);
      return;
    }

    if (createTask && taskCode && eventCode) {
      const tr = await fetch(`${ADMIN_URL}/event-tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          task_code: taskCode,
          event_code: eventCode,
          category: taskCategory,
          display_name: display,
          description: taskDesc || desc,
        }),
      });
      if (!tr.ok) {
        const terr = await tr.json();
        setStatus(`Tool created but task registration failed: ${JSON.stringify(terr)}`);
        return;
      }
    }

    await fetch(`${MCP_URL}/tools/reload`, { method: "POST" });
    setStatus("Created. MCP reloaded.");
    onDone();
    setTimeout(onClose, 500);
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(16,24,40,0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 50,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="card"
        style={{ width: 720, maxWidth: "94vw", padding: 0, maxHeight: "90vh", overflowY: "auto" }}
      >
        <div
          style={{
            padding: "12px 18px",
            borderBottom: "1px solid var(--border)",
            display: "flex",
            justifyContent: "space-between",
          }}
        >
          <strong>Register a new tool</strong>
          <button onClick={onClose}>Close</button>
        </div>
        <div style={{ padding: 18 }}>
          <Field label="Tool name (snake_case)">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="send_joiner_announcement" />
          </Field>
          <Field label="Display name">
            <input value={display} onChange={(e) => setDisplay(e.target.value)} />
          </Field>
          <Field label="Description (written for the LLM — tell it when to use this tool)">
            <textarea rows={3} value={desc} onChange={(e) => setDesc(e.target.value)} />
          </Field>
          <div style={{ display: "grid", gridTemplateColumns: "3fr 1fr", gap: 12 }}>
            <Field label="Endpoint URL">
              <input value={endpoint} onChange={(e) => setEndpoint(e.target.value)} />
            </Field>
            <Field label="Method">
              <select value={method} onChange={(e) => setMethod(e.target.value)}>
                <option>POST</option>
                <option>GET</option>
                <option>PUT</option>
                <option>DELETE</option>
              </select>
            </Field>
          </div>
          <Field label="Associate with event">
            <select value={eventCode} onChange={(e) => { setEventCode(e.target.value); setCreateTask(false); }}>
              <option value="">— None (no event) —</option>
              {events.map((ev) => (
                <option key={ev.event_code} value={ev.event_code}>
                  {ev.display_name} ({ev.event_code})
                </option>
              ))}
            </select>
          </Field>
          <Field label="Input schema (JSON Schema)">
            <textarea
              rows={10}
              value={schema}
              onChange={(e) => setSchema(e.target.value)}
              style={{ fontFamily: "ui-monospace, monospace", fontSize: 12 }}
            />
          </Field>

          {eventCode && (
            <div
              style={{
                border: "1px solid var(--border)",
                borderRadius: 6,
                padding: 12,
                marginBottom: 12,
                background: "#f9fafb",
              }}
            >
              <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", marginBottom: createTask ? 12 : 0 }}>
                <input
                  type="checkbox"
                  checked={createTask}
                  onChange={(e) => setCreateTask(e.target.checked)}
                />
                <span className="small">
                  <strong>Also register as an event task</strong> — adds this tool as a
                  trackable task in the {eventCode} task catalogue
                </span>
              </label>
              {createTask && (
                <>
                  <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 12 }}>
                    <Field label="Task code (SCREAMING_SNAKE_CASE)">
                      <input
                        value={taskCode}
                        onChange={(e) => setTaskCode(e.target.value.toUpperCase())}
                        placeholder="JJ_SEND_ANNOUNCEMENT"
                      />
                    </Field>
                    <Field label="Category">
                      <select value={taskCategory} onChange={(e) => setTaskCategory(e.target.value)}>
                        <option value="CONNECT">CONNECT</option>
                        <option value="SYSTEM">SYSTEM</option>
                        <option value="DOCUMENT">DOCUMENT</option>
                      </select>
                    </Field>
                  </div>
                  <Field label="Task description (shown to employee — leave blank to use tool description)">
                    <input
                      value={taskDesc}
                      onChange={(e) => setTaskDesc(e.target.value)}
                      placeholder={desc || "e.g. Send an announcement introducing your joining to the team."}
                    />
                  </Field>
                  <p className="small muted" style={{ margin: "4px 0 0" }}>
                    Task will appear as pending for all employees currently active in the {eventCode} event.
                  </p>
                </>
              )}
            </div>
          )}

          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button
              className="primary"
              onClick={submit}
              disabled={!name || !display || !desc || !endpoint}
            >
              Create tool
            </button>
            {status && <span className="small muted">{status}</span>}
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div className="small muted" style={{ marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  );
}
