"""
Documents API  —  captures document acceptances (contract, code of conduct,
compliance training).
"""
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from .db import execute, execute_returning, query

app = FastAPI(title="Vision Enterprise — Documents API", version="1.0")
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
)

DOC_TO_TASK = {
    "CONTRACT":             "JJ_CONTRACT",
    "CODE_OF_CONDUCT":      "JJ_CODE_OF_CONDUCT",
    "COMPLIANCE_TRAINING":  "JJ_COMPLIANCE_TRAINING",
}


class AcceptReq(BaseModel):
    employee_id: str
    document_type: str = Field(..., pattern="^(CONTRACT|CODE_OF_CONDUCT|COMPLIANCE_TRAINING)$")


@app.get("/health")
def health():
    return {"status": "ok", "service": "documents-api"}


@app.post("/accept")
def accept(req: AcceptReq):
    if req.document_type not in DOC_TO_TASK:
        raise HTTPException(400, "Invalid document_type")
    execute_returning(
        """
        INSERT INTO document_acceptances (employee_id, document_type, accepted, accepted_at)
        VALUES (%s, %s, TRUE, NOW())
        ON CONFLICT (employee_id, document_type)
        DO UPDATE SET accepted = TRUE, accepted_at = NOW()
        RETURNING id
        """,
        (req.employee_id, req.document_type),
    )
    task_code = DOC_TO_TASK[req.document_type]
    execute(
        """
        UPDATE employee_task_status SET status = 'completed', updated_at = NOW()
        WHERE employee_id = %s AND task_code = %s
        """,
        (req.employee_id, task_code),
    )
    return {"ok": True, "document_type": req.document_type, "task_completed": task_code}


@app.get("/acceptances/{employee_id}")
def list_acceptances(employee_id: str):
    return query(
        """
        SELECT document_type, accepted, accepted_at::text AS accepted_at
        FROM document_acceptances WHERE employee_id = %s
        ORDER BY document_type
        """,
        (employee_id,),
    )
