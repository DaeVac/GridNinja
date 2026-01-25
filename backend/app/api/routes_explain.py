"""
routes_explain.py

Purpose:
  API endpoint for generating LLM-powered explanations of blocked decisions.
  Only fires on explicit POST request (button click), never automatically.

Endpoints:
  - POST /explain/decision: Accepts decision JSON, returns Post-Mortem Report
"""
from __future__ import annotations

import time
from typing import Any, Dict

from fastapi import APIRouter
from pydantic import BaseModel

from app.services.llm_explainer import explain_decision

router = APIRouter()

# Simple rate limiting (1.5s cooldown)
_last_call_ts = 0.0


class ExplainRequest(BaseModel):
    decision: Dict[str, Any]


class ExplainResponse(BaseModel):
    report_markdown: str
    cause: str
    confidence: float
    from_llm: bool


@router.post("/decision", response_model=ExplainResponse)
async def explain_decision_endpoint(req: ExplainRequest):
    """
    Generate a Post-Mortem Report explaining why a decision was blocked/clipped.
    
    Rate limited to 1.5s between calls to prevent spam.
    """
    global _last_call_ts
    now = time.time()
    
    if now - _last_call_ts < 1.5:
        return ExplainResponse(
            report_markdown="Rate limited: please wait a moment and try again.",
            cause="POLICY/RAMP",
            confidence=0.0,
            from_llm=False
        )
    
    _last_call_ts = now
    result = explain_decision(req.decision)
    
    return ExplainResponse(**result)
