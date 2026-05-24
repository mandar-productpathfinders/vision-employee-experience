"""
Onboarding API  —  captures IT onboarding form and HR profile completion.
"""
import os
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, field_validator
from typing import Optional
from .db import query_one, execute, execute_returning

DB_ENCRYPTION_KEY = os.environ.get("DB_ENCRYPTION_KEY", "change-me-before-production")

app = FastAPI(title="Vision Enterprise — Onboarding API", version="1.0")
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
)


# ---- IT Onboarding ---------------------------------------------------------

class ITOnboardingReq(BaseModel):
    employee_id: str
    laptop_preference: str = Field(..., pattern="^(Mac|HP|Dell)$")
    drop_destination: str
    # Optional — if caller supplies, override HRMS auto-fill
    work_number: Optional[str] = None
    emergency_contact: Optional[str] = None
    cost_center: Optional[str] = None


@app.get("/health")
def health():
    return {"status": "ok", "service": "onboarding-api"}


@app.post("/it-onboarding")
def submit_it_onboarding(req: ITOnboardingReq):
    # Pull HR-filled fields if caller didn't supply them. Matches the prompt's
    # requirement: "Work number, Emergency Contact, Cost center Code are filled
    # using information in HR ERP system."
    emp = query_one(
        "SELECT work_number, emergency_contact, cost_center FROM employees WHERE employee_id = %s",
        (req.employee_id,),
    )
    if not emp:
        raise HTTPException(404, f"Employee {req.employee_id} not found")

    work_number = req.work_number or emp["work_number"]
    emergency_contact = req.emergency_contact or emp["emergency_contact"]
    cost_center = req.cost_center or emp["cost_center"]

    row = execute_returning(
        """
        INSERT INTO it_onboarding_submissions
          (employee_id, laptop_preference, work_number, emergency_contact,
           cost_center, drop_destination)
        VALUES (%s, %s, %s, %s, %s, %s)
        RETURNING id, submitted_at::text AS submitted_at
        """,
        (req.employee_id, req.laptop_preference, work_number, emergency_contact,
         cost_center, req.drop_destination),
    )
    # Mark the task complete so the UI reflects progress
    execute(
        """
        UPDATE employee_task_status SET status = 'completed', updated_at = NOW()
        WHERE employee_id = %s AND task_code = 'JJ_IT_ONBOARDING'
        """,
        (req.employee_id,),
    )
    return {
        "ok": True,
        "submission_id": row["id"],
        "submitted_at": row["submitted_at"],
        "laptop_preference": req.laptop_preference,
        "drop_destination": req.drop_destination,
        "auto_filled": {
            "work_number": work_number,
            "emergency_contact": emergency_contact,
            "cost_center": cost_center,
        },
    }


# ---- HR Profile ------------------------------------------------------------

class HRProfileReq(BaseModel):
    employee_id: str
    pan_number: str = Field(..., pattern=r"^[A-Z]{5}[0-9]{4}[A-Z]$")
    bank_name: str = Field(..., min_length=2, max_length=100)
    bank_account: str = Field(..., pattern=r"^\d{9,18}$")
    ifsc_code: str = Field(..., pattern=r"^[A-Z]{4}0[A-Z0-9]{6}$")
    tax_regime: str = Field(..., pattern="^(OLD|NEW)$")

    @field_validator("pan_number", "ifsc_code", mode="before")
    @classmethod
    def uppercase_and_strip(cls, v: str) -> str:
        return v.strip().upper()

    @field_validator("bank_account", mode="before")
    @classmethod
    def strip_account(cls, v: str) -> str:
        return v.strip().replace(" ", "")

    @field_validator("bank_name", mode="before")
    @classmethod
    def strip_name(cls, v: str) -> str:
        return v.strip()


@app.post("/hr-profile")
def submit_hr_profile(req: HRProfileReq):
    row = execute_returning(
        """
        INSERT INTO hr_profile_submissions
          (employee_id, pan_number, bank_name, bank_account, ifsc_code, tax_regime)
        VALUES (
          %s,
          pgp_sym_encrypt(%s, %s),
          %s,
          pgp_sym_encrypt(%s, %s),
          pgp_sym_encrypt(%s, %s),
          %s
        )
        RETURNING id, submitted_at::text AS submitted_at
        """,
        (
            req.employee_id,
            req.pan_number,    DB_ENCRYPTION_KEY,
            req.bank_name,
            req.bank_account,  DB_ENCRYPTION_KEY,
            req.ifsc_code,     DB_ENCRYPTION_KEY,
            req.tax_regime,
        ),
    )
    execute(
        """
        UPDATE employee_task_status SET status = 'completed', updated_at = NOW()
        WHERE employee_id = %s AND task_code = 'JJ_HR_PROFILE'
        """,
        (req.employee_id,),
    )
    return {"ok": True, "submission_id": row["id"], "submitted_at": row["submitted_at"]}


@app.get("/submissions/{employee_id}")
def get_submissions(employee_id: str):
    """Used by the UI to show what was captured."""
    it = query_one(
        """
        SELECT id, laptop_preference, work_number, emergency_contact,
               cost_center, drop_destination, submitted_at::text AS submitted_at
        FROM it_onboarding_submissions
        WHERE employee_id = %s ORDER BY submitted_at DESC LIMIT 1
        """,
        (employee_id,),
    )
    hr = query_one(
        """
        SELECT id, pan_number, bank_name, bank_account, ifsc_code, tax_regime,
               submitted_at::text AS submitted_at
        FROM hr_profile_submissions
        WHERE employee_id = %s ORDER BY submitted_at DESC LIMIT 1
        """,
        (employee_id,),
    )
    return {"it_onboarding": it, "hr_profile": hr}
