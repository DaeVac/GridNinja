# apps/backend/app/schemas/decision.py
from typing import Any, Dict, List, Optional
from pydantic import BaseModel


class DecisionResponse(BaseModel):
    ts: str
    decision_id: str

    requested_deltaP_kw: float
    approved_deltaP_kw: float

    blocked: bool
    reason: str

    plan: Dict[str, Any]
    trace: List[Dict[str, Any]]

    prediction_debug: Optional[Dict[str, float]] = None
