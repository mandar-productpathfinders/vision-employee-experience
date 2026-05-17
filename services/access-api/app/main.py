"""
Access API  —  captures tool-access requests (GitHub, Slack, Figma, Jira, Camtasia).
"""
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Optional
from .db import execute, execute_returning, query_one

app = FastAPI(title="Vision Enterprise — Access API", version="1.0")
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
)

AVAILABLE_TOOLS = ["Figma", "Jira", "Camtasia"]


class AccessReq(BaseModel):
    employee_id: str
    github_username: Optional[str] = None
    slack_display_name: Optional[str] = None
    additional_tools: Optional[List[str]] = None


@app.get("/health")
def health():
    return {"status": "ok", "service": "access-api"}


@app.get("/available-tools")
def available_tools():
    return {"tools": AVAILABLE_TOOLS}


@app.post("/access-request")
def submit_access_request(req: AccessReq):
    tools_csv = ",".join(req.additional_tools) if req.additional_tools else None
    row = execute_returning(
        """
        INSERT INTO access_requests
          (employee_id, github_username, slack_display_name, additional_tools)
        VALUES (%s, %s, %s, %s)
        RETURNING id, submitted_at::text AS submitted_at
        """,
        (req.employee_id, req.github_username, req.slack_display_name, tools_csv),
    )
    execute(
        """
        UPDATE employee_task_status SET status = 'completed', updated_at = NOW()
        WHERE employee_id = %s AND task_code = 'JJ_ACCESS_REQUEST'
        """,
        (req.employee_id,),
    )
    return {
        "ok": True,
        "request_id": row["id"],
        "submitted_at": row["submitted_at"],
        "tools_requested": req.additional_tools or [],
    }


@app.get("/requests/{employee_id}")
def get_requests(employee_id: str):
    row = query_one(
        """
        SELECT id, github_username, slack_display_name, additional_tools,
               submitted_at::text AS submitted_at
        FROM access_requests WHERE employee_id = %s
        ORDER BY submitted_at DESC LIMIT 1
        """,
        (employee_id,),
    )
    return row or {}
