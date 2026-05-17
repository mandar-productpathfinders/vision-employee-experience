"""
Admin API  —  manages the editable prompt and tool registry.

This service is the heart of the "prompt-as-business-process" story:
  * Admin can update the JUST_JOINED prompt → next agent turn picks it up.
  * Admin can register a brand-new tool → MCP server hot-reloads and exposes
    it to the agent with zero redeploy.

Endpoints:
  GET  /prompt/{event_code}       — active prompt for an event
  PUT  /prompt/{event_code}       — update prompt (creates new version)
  GET  /prompt-history/{event_code}

  GET  /tools                     — full active tool registry (read by MCP)
  POST /tools                     — add a new tool at runtime
  PUT  /tools/{tool_name}         — edit existing tool (non-system)
  POST /tools/{tool_name}/toggle  — activate / deactivate
  DELETE /tools/{tool_name}       — remove (non-system only)
"""
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from typing import Optional
from .db import query, query_one, execute, execute_returning
import json

app = FastAPI(title="Vision Enterprise — Admin API", version="1.0")
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
)


# =============================================================================
# PROMPT MANAGEMENT
# =============================================================================

class PromptUpdate(BaseModel):
    prompt_text: str
    updated_by: str = "admin"


@app.get("/health")
def health():
    return {"status": "ok", "service": "admin-api"}


@app.get("/prompt/{event_code}")
def get_active_prompt(event_code: str):
    row = query_one(
        """
        SELECT id, event_code, prompt_text, version, is_active,
               updated_by, updated_at::text AS updated_at
        FROM admin_prompts
        WHERE event_code = %s AND is_active = TRUE
        ORDER BY version DESC LIMIT 1
        """,
        (event_code,),
    )
    if not row:
        raise HTTPException(404, f"No active prompt for event {event_code}")
    return row


@app.put("/prompt/{event_code}")
def update_prompt(event_code: str, req: PromptUpdate):
    # Archive current active
    execute(
        "UPDATE admin_prompts SET is_active = FALSE WHERE event_code = %s",
        (event_code,),
    )
    # Insert new active version
    next_version = query_one(
        "SELECT COALESCE(MAX(version), 0) + 1 AS v FROM admin_prompts WHERE event_code = %s",
        (event_code,),
    )["v"]
    row = execute_returning(
        """
        INSERT INTO admin_prompts (event_code, prompt_text, version, is_active, updated_by)
        VALUES (%s, %s, %s, TRUE, %s)
        RETURNING id, version, updated_at::text AS updated_at
        """,
        (event_code, req.prompt_text, next_version, req.updated_by),
    )
    return {"ok": True, **row}


@app.get("/prompt-history/{event_code}")
def history(event_code: str):
    return query(
        """
        SELECT id, version, is_active, updated_by,
               updated_at::text AS updated_at,
               LEFT(prompt_text, 200) AS preview
        FROM admin_prompts
        WHERE event_code = %s
        ORDER BY version DESC
        """,
        (event_code,),
    )


# =============================================================================
# TOOL REGISTRY
# =============================================================================

class ToolCreate(BaseModel):
    tool_name: str = Field(..., pattern="^[a-z][a-z0-9_]*$",
                           description="snake_case; what the LLM calls")
    display_name: str
    description: str = Field(..., min_length=10,
                             description="Written for the LLM — explain when to use this tool")
    input_schema: dict
    endpoint_url: str
    http_method: str = "POST"
    event_code: Optional[str] = None
    is_active: bool = True
    linked_task_code: Optional[str] = None


class ToolUpdate(BaseModel):
    display_name: Optional[str] = None
    description: Optional[str] = None
    input_schema: Optional[dict] = None
    endpoint_url: Optional[str] = None
    http_method: Optional[str] = None
    is_active: Optional[bool] = None


@app.get("/tools")
def list_tools(active_only: bool = True, event_code: Optional[str] = None):
    """
    The MCP server polls this endpoint to build its live tool registry.
    Returns active tools by default.
    """
    sql = """
        SELECT tool_name, display_name, description, input_schema,
               endpoint_url, http_method, event_code, is_active, is_system,
               linked_task_code, updated_at::text AS updated_at
        FROM admin_tools
    """
    params: list = []
    conditions: list = []
    if active_only:
        conditions.append("is_active = TRUE")
    if event_code:
        conditions.append("(event_code = %s OR event_code IS NULL)")
        params.append(event_code)
    if conditions:
        sql += " WHERE " + " AND ".join(conditions)
    sql += " ORDER BY is_system DESC, tool_name"
    return query(sql, tuple(params))


@app.get("/tools/{tool_name}")
def get_tool(tool_name: str):
    row = query_one(
        """
        SELECT tool_name, display_name, description, input_schema, endpoint_url,
               http_method, event_code, is_active, is_system,
               linked_task_code, updated_at::text AS updated_at
        FROM admin_tools WHERE tool_name = %s
        """,
        (tool_name,),
    )
    if not row:
        raise HTTPException(404, f"Tool {tool_name} not found")
    return row


@app.post("/tools")
def create_tool(t: ToolCreate):
    existing = query_one("SELECT 1 FROM admin_tools WHERE tool_name = %s", (t.tool_name,))
    if existing:
        raise HTTPException(409, f"Tool {t.tool_name} already exists")
    row = execute_returning(
        """
        INSERT INTO admin_tools
          (tool_name, display_name, description, input_schema, endpoint_url,
           http_method, event_code, is_active, is_system, linked_task_code)
        VALUES (%s, %s, %s, %s::jsonb, %s, %s, %s, %s, FALSE, %s)
        RETURNING tool_name, updated_at::text AS updated_at
        """,
        (t.tool_name, t.display_name, t.description, json.dumps(t.input_schema),
         t.endpoint_url, t.http_method, t.event_code, t.is_active, t.linked_task_code),
    )
    return {"ok": True, **row}


@app.put("/tools/{tool_name}")
def update_tool(tool_name: str, t: ToolUpdate):
    existing = query_one(
        "SELECT is_system FROM admin_tools WHERE tool_name = %s", (tool_name,)
    )
    if not existing:
        raise HTTPException(404, f"Tool {tool_name} not found")
    if existing["is_system"] and (t.endpoint_url or t.input_schema):
        raise HTTPException(403, "Cannot modify endpoint or schema of a system tool")

    # Build dynamic update
    sets: list = []
    params: list = []
    if t.display_name is not None:
        sets.append("display_name = %s"); params.append(t.display_name)
    if t.description is not None:
        sets.append("description = %s"); params.append(t.description)
    if t.input_schema is not None:
        sets.append("input_schema = %s::jsonb"); params.append(json.dumps(t.input_schema))
    if t.endpoint_url is not None:
        sets.append("endpoint_url = %s"); params.append(t.endpoint_url)
    if t.http_method is not None:
        sets.append("http_method = %s"); params.append(t.http_method)
    if t.is_active is not None:
        sets.append("is_active = %s"); params.append(t.is_active)
    if not sets:
        return {"ok": True, "no_changes": True}
    sets.append("updated_at = NOW()")
    params.append(tool_name)
    execute(f"UPDATE admin_tools SET {', '.join(sets)} WHERE tool_name = %s", tuple(params))
    return {"ok": True, "tool_name": tool_name}


@app.post("/tools/{tool_name}/toggle")
def toggle_tool(tool_name: str):
    row = query_one("SELECT is_active FROM admin_tools WHERE tool_name = %s", (tool_name,))
    if not row:
        raise HTTPException(404, f"Tool {tool_name} not found")
    new_state = not row["is_active"]
    execute(
        "UPDATE admin_tools SET is_active = %s, updated_at = NOW() WHERE tool_name = %s",
        (new_state, tool_name),
    )
    return {"ok": True, "tool_name": tool_name, "is_active": new_state}


@app.delete("/tools/{tool_name}")
def delete_tool(tool_name: str):
    existing = query_one(
        "SELECT is_system FROM admin_tools WHERE tool_name = %s", (tool_name,)
    )
    if not existing:
        raise HTTPException(404, f"Tool {tool_name} not found")
    if existing["is_system"]:
        raise HTTPException(403, "Cannot delete a system tool — use toggle instead")
    execute("DELETE FROM admin_tools WHERE tool_name = %s", (tool_name,))
    return {"ok": True, "deleted": tool_name}


# =============================================================================
# EVENTS + TASK CATALOGUE
# =============================================================================

class EventTaskCreate(BaseModel):
    task_code: str = Field(..., description="Unique task code, e.g. JJ_SEND_ANNOUNCEMENT")
    event_code: str
    category: str = Field(..., description="SYSTEM | DOCUMENT | CONNECT")
    display_name: str
    description: str = ""
    sort_order: int = 100


@app.get("/events")
def list_events():
    return query(
        "SELECT event_code, display_name, is_demo_ready FROM events ORDER BY sort_order",
        (),
    )


@app.get("/event-tasks")
def list_event_tasks(event_code: Optional[str] = None):
    if event_code:
        return query(
            """
            SELECT task_code, event_code, category, display_name, description, sort_order
            FROM event_tasks WHERE event_code = %s ORDER BY sort_order
            """,
            (event_code,),
        )
    return query(
        "SELECT task_code, event_code, category, display_name, description, sort_order FROM event_tasks ORDER BY event_code, sort_order",
        (),
    )


@app.post("/event-tasks")
def create_event_task(t: EventTaskCreate):
    existing = query_one("SELECT 1 FROM event_tasks WHERE task_code = %s", (t.task_code,))
    if existing:
        raise HTTPException(409, f"Task {t.task_code} already exists")
    event = query_one("SELECT 1 FROM events WHERE event_code = %s", (t.event_code,))
    if not event:
        raise HTTPException(404, f"Event {t.event_code} not found")
    execute(
        """
        INSERT INTO event_tasks (task_code, event_code, category, display_name, description, sort_order)
        VALUES (%s, %s, %s, %s, %s, %s)
        """,
        (t.task_code, t.event_code, t.category.upper(), t.display_name, t.description, t.sort_order),
    )
    # Seed pending status for all employees currently active in this event
    execute(
        """
        INSERT INTO employee_task_status (employee_id, task_code, status)
        SELECT ee.employee_id, %s, 'pending'
        FROM employee_events ee
        WHERE ee.event_code = %s AND ee.status = 'active'
        ON CONFLICT (employee_id, task_code) DO NOTHING
        """,
        (t.task_code, t.event_code),
    )
    return {"ok": True, "task_code": t.task_code}


class EventTaskUpdate(BaseModel):
    display_name: Optional[str] = None
    category: Optional[str] = None
    description: Optional[str] = None
    sort_order: Optional[int] = None


@app.put("/event-tasks/{task_code}")
def update_event_task(task_code: str, t: EventTaskUpdate):
    existing = query_one("SELECT 1 FROM event_tasks WHERE task_code = %s", (task_code,))
    if not existing:
        raise HTTPException(404, f"Task {task_code} not found")
    sets: list = []
    params: list = []
    if t.display_name is not None:
        sets.append("display_name = %s"); params.append(t.display_name)
    if t.category is not None:
        sets.append("category = %s"); params.append(t.category.upper())
    if t.description is not None:
        sets.append("description = %s"); params.append(t.description)
    if t.sort_order is not None:
        sets.append("sort_order = %s"); params.append(t.sort_order)
    if not sets:
        return {"ok": True, "no_changes": True}
    params.append(task_code)
    execute(f"UPDATE event_tasks SET {', '.join(sets)} WHERE task_code = %s", tuple(params))
    return {"ok": True, "task_code": task_code}


@app.delete("/event-tasks/{task_code}")
def delete_event_task(task_code: str):
    existing = query_one("SELECT 1 FROM event_tasks WHERE task_code = %s", (task_code,))
    if not existing:
        raise HTTPException(404, f"Task {task_code} not found")
    completed = query_one(
        "SELECT COUNT(*) AS n FROM employee_task_status WHERE task_code = %s AND status = 'completed'",
        (task_code,),
    )
    if completed and completed["n"] > 0:
        raise HTTPException(
            409,
            f"Cannot delete task {task_code}: {completed['n']} employee(s) have completed it. Deactivate instead.",
        )
    execute("DELETE FROM employee_task_status WHERE task_code = %s", (task_code,))
    execute("DELETE FROM event_tasks WHERE task_code = %s", (task_code,))
    return {"ok": True, "deleted": task_code}
