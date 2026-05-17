"""
Calendar API  —  books connect meetings (manager intro, buddy meet, townhall).

Booking logic is deliberately simple for the demo:
  MANAGER_INTRO / BUDDY_MEET : pick the first of the preferred dates provided
                               at 10:00 local time; attach the employee's
                               manager name (or a canned buddy).
  TOWNHALL                   : always the next Friday 16:00 (fixed calendar
                               event that all new joiners attend together).
"""
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from typing import List, Optional
from datetime import datetime, date, timedelta
from .db import query_one, execute, execute_returning, query

app = FastAPI(title="Vision Enterprise — Calendar API", version="1.0")
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
)

TASK_MAP = {
    "MANAGER_INTRO": "JJ_MANAGER_INTRO",
    "BUDDY_MEET":    "JJ_BUDDY_MEET",
    "TOWNHALL":      "JJ_TOWNHALL",
}

AGENDAS = {
    "MANAGER_INTRO":
        "Role expectations & success criteria; Team ways of working; "
        "Preferred communication style; 30-60-90 day goals.",
    "BUDDY_MEET":
        "Team culture & unwritten norms; Who to go to for what; "
        "Tips for first 30 days; Q&A — anything goes.",
    "TOWNHALL":
        "Org strategy & vision; Culture & values; Open Q&A with leadership.",
}


class BookReq(BaseModel):
    employee_id: str
    meeting_type: str = Field(..., pattern="^(MANAGER_INTRO|BUDDY_MEET|TOWNHALL)$")
    preferred_dates: Optional[List[str]] = None  # ISO date strings


def _next_friday_1600() -> datetime:
    today = date.today()
    days_until_fri = (4 - today.weekday()) % 7
    if days_until_fri == 0:
        days_until_fri = 7
    friday = today + timedelta(days=days_until_fri)
    return datetime.combine(friday, datetime.min.time()).replace(hour=16)


def _resolve_slot(meeting_type: str, preferred: Optional[List[str]]) -> datetime:
    if meeting_type == "TOWNHALL":
        return _next_friday_1600()
    if preferred:
        try:
            first = datetime.fromisoformat(preferred[0])
            # Normalise to 10:00 if caller gave date-only
            if first.hour == 0 and first.minute == 0:
                first = first.replace(hour=10)
            return first
        except ValueError:
            pass
    # Fallback: day after tomorrow at 10:00
    fallback = date.today() + timedelta(days=2)
    return datetime.combine(fallback, datetime.min.time()).replace(hour=10)


@app.get("/health")
def health():
    return {"status": "ok", "service": "calendar-api"}


@app.post("/book")
def book(req: BookReq):
    emp = query_one(
        "SELECT manager_name FROM employees WHERE employee_id = %s",
        (req.employee_id,),
    )
    if not emp:
        raise HTTPException(404, f"Employee {req.employee_id} not found")

    booked_with = {
        "MANAGER_INTRO": emp["manager_name"] or "Your Manager",
        "BUDDY_MEET":    "Ritika Shah (Buddy)",
        "TOWNHALL":      "Leadership Team",
    }[req.meeting_type]

    slot = _resolve_slot(req.meeting_type, req.preferred_dates)

    row = execute_returning(
        """
        INSERT INTO connect_meetings
          (employee_id, meeting_type, preferred_dates, booked_slot, booked_with,
           agenda, status)
        VALUES (%s, %s, %s, %s, %s, %s, 'booked')
        RETURNING id, booked_slot::text AS booked_slot
        """,
        (
            req.employee_id,
            req.meeting_type,
            ",".join(req.preferred_dates) if req.preferred_dates else None,
            slot,
            booked_with,
            AGENDAS[req.meeting_type],
        ),
    )
    # Mark corresponding task complete
    execute(
        """
        UPDATE employee_task_status SET status = 'completed', updated_at = NOW()
        WHERE employee_id = %s AND task_code = %s
        """,
        (req.employee_id, TASK_MAP[req.meeting_type]),
    )
    return {
        "ok": True,
        "meeting_id": row["id"],
        "meeting_type": req.meeting_type,
        "booked_slot": row["booked_slot"],
        "booked_with": booked_with,
        "agenda": AGENDAS[req.meeting_type],
    }


@app.get("/meetings/{employee_id}")
def list_meetings(employee_id: str):
    return query(
        """
        SELECT id, meeting_type, booked_slot::text AS booked_slot,
               booked_with, agenda, status
        FROM connect_meetings
        WHERE employee_id = %s ORDER BY booked_slot
        """,
        (employee_id,),
    )
