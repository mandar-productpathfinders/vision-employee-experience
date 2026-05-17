"""
Announcement API  —  the backing store for the admin-added tool.

The tool `send_joiner_announcement` is NOT pre-registered in admin_tools. The
admin adds it live during the demo, pointing at this service's /send endpoint.
When invoked, invocations are queued here. Actual mail delivery (trigger /
batch push) is out of scope for this use case.
"""
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional, List
from .db import query, query_one, execute_returning

app = FastAPI(title="Vision Enterprise — Announcement API", version="1.0")
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
)


class SendReq(BaseModel):
    employee_id: Optional[str] = None
    recipient_list: str   # CSV of email addresses / distribution lists
    subject: str
    body: str


@app.get("/health")
def health():
    return {"status": "ok", "service": "announcement-api"}


@app.post("/send")
def send_announcement(req: SendReq):
    """
    Queues an announcement. The response shape is what the LLM will see — keep
    it small, readable, and structured.
    """
    row = execute_returning(
        """
        INSERT INTO announcement_queue
          (employee_id, recipient_list, subject, body, status)
        VALUES (%s, %s, %s, %s, 'queued')
        RETURNING id, created_at::text AS created_at
        """,
        (req.employee_id, req.recipient_list, req.subject, req.body),
    )
    return {
        "ok": True,
        "announcement_id": row["id"],
        "queued_at": row["created_at"],
        "recipients": req.recipient_list,
        "subject": req.subject,
        "status": "queued_for_delivery",
    }


@app.get("/announcements")
def list_announcements(employee_id: Optional[str] = None):
    if employee_id:
        return query(
            """
            SELECT id, employee_id, recipient_list, subject, body, status,
                   created_at::text AS created_at, sent_at::text AS sent_at
            FROM announcement_queue
            WHERE employee_id = %s ORDER BY created_at DESC
            """,
            (employee_id,),
        )
    return query(
        """
        SELECT id, employee_id, recipient_list, subject, body, status,
               created_at::text AS created_at, sent_at::text AS sent_at
        FROM announcement_queue ORDER BY created_at DESC LIMIT 50
        """
    )
