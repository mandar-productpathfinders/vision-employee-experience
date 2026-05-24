"""
HRMS API  —  the dummy HR system of record.
Exposes employee profile, event list, pending tasks, and task completion.
Profile lookups are read-through cached in Redis (5-minute TTL).
"""
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Optional
from .db import query, query_one, execute, cache_get_json, cache_set_json

app = FastAPI(title="Vision Enterprise — HRMS API", version="1.0")
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
)

PROFILE_CACHE_TTL = 300  # 5 minutes


# ---- Models ----------------------------------------------------------------

class Profile(BaseModel):
    employee_id: str
    full_name: str
    email: str
    gender: Optional[str] = None
    date_of_joining: str
    manager_id: Optional[str] = None
    manager_name: Optional[str] = None
    department: Optional[str] = None
    designation: Optional[str] = None
    cost_center: Optional[str] = None
    work_number: Optional[str] = None
    emergency_contact: Optional[str] = None
    location: Optional[str] = None


class EventRow(BaseModel):
    event_code: str
    display_name: str
    status: str
    triggered_at: str


class TaskRow(BaseModel):
    task_code: str
    display_name: str
    category: str
    description: str
    status: str
    sort_order: int


class CompleteTaskReq(BaseModel):
    employee_id: str
    task_code: str


# ---- Endpoints -------------------------------------------------------------

@app.get("/health")
def health():
    return {"status": "ok", "service": "hrms-api"}


@app.get("/profile", response_model=Profile)
def get_profile(employee_id: str = Query(...)):
    """Profile lookup with Redis read-through cache."""
    cache_key = f"hrms:profile:{employee_id}"
    cached = cache_get_json(cache_key)
    if cached:
        cached["_cache"] = "hit"
        return cached

    row = query_one(
        """
        SELECT employee_id, full_name, email, gender,
               date_of_joining::text, manager_id, manager_name,
               department, designation, cost_center,
               work_number, emergency_contact, location
        FROM employees
        WHERE employee_id = %s AND is_active = TRUE
        """,
        (employee_id,),
    )
    if not row:
        raise HTTPException(404, f"Employee {employee_id} not found")
    cache_set_json(cache_key, row, PROFILE_CACHE_TTL)
    row["_cache"] = "miss"
    return row


@app.get("/employees")
def list_employees():
    """List all active employees (for the login picker in the demo UI)."""
    rows = query(
        """
        SELECT employee_id, full_name, email, designation, department
        FROM employees
        WHERE is_active = TRUE AND employee_id LIKE 'E1%%'
        ORDER BY employee_id
        """
    )
    return rows


@app.get("/events", response_model=List[EventRow])
def list_employee_events(employee_id: str = Query(...)):
    rows = query(
        """
        SELECT ee.event_code, e.display_name, ee.status,
               ee.triggered_at::text AS triggered_at
        FROM employee_events ee
        JOIN events e ON e.event_code = ee.event_code
        WHERE ee.employee_id = %s AND ee.status = 'active'
        ORDER BY e.sort_order
        """,
        (employee_id,),
    )
    return rows


@app.get("/tasks/pending", response_model=List[TaskRow])
def list_pending_tasks(
    employee_id: str = Query(...), event_code: Optional[str] = Query(None)
):
    sql = """
        SELECT et.task_code, et.display_name, et.category, et.description,
               ets.status, et.sort_order
        FROM employee_task_status ets
        JOIN event_tasks et ON et.task_code = ets.task_code
        WHERE ets.employee_id = %s AND ets.status <> 'completed'
    """
    params: list = [employee_id]
    if event_code:
        sql += " AND et.event_code = %s"
        params.append(event_code)
    sql += " ORDER BY et.sort_order"
    return query(sql, tuple(params))


@app.get("/tasks")
def list_all_tasks(employee_id: str = Query(...)):
    """All tasks with status — used by the UI progress tracker."""
    return query(
        """
        SELECT et.task_code, et.display_name, et.category, et.description,
               et.event_code, ets.status, ets.updated_at::text AS updated_at
        FROM employee_task_status ets
        JOIN event_tasks et ON et.task_code = ets.task_code
        WHERE ets.employee_id = %s
        ORDER BY et.sort_order
        """,
        (employee_id,),
    )


@app.post("/tasks/complete")
def complete_task(req: CompleteTaskReq):
    rows = execute(
        """
        UPDATE employee_task_status
        SET status = 'completed', updated_at = NOW()
        WHERE employee_id = %s AND task_code = %s
        """,
        (req.employee_id, req.task_code),
    )
    if rows == 0:
        raise HTTPException(404, "Task not found for this employee")
    return {"ok": True, "employee_id": req.employee_id, "task_code": req.task_code}


@app.post("/cache/invalidate")
def invalidate_cache(employee_id: str = Query(...)):
    """Useful during demos to force a cache miss for the next profile call."""
    from .db import get_redis
    get_redis().delete(f"hrms:profile:{employee_id}")
    return {"ok": True, "invalidated": f"hrms:profile:{employee_id}"}


import json as _json

@app.post("/traces")
def save_trace(payload: dict):
    """Persist a masked agent tool trace for audit purposes."""
    execute(
        """
        INSERT INTO agent_traces
          (employee_id, session_id, turn_number, tool_name, tool_input, tool_output, latency_ms, model)
        VALUES (%s, %s, %s, %s, %s::jsonb, %s::jsonb, %s, %s)
        """,
        (
            payload.get("employee_id"),
            payload.get("session_id"),
            payload.get("turn"),
            payload.get("tool"),
            _json.dumps(payload.get("input")),
            _json.dumps(payload.get("result")),
            payload.get("latency_ms"),
            payload.get("model"),
        ),
    )
    return {"ok": True}
