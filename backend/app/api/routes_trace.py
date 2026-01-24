from __future__ import annotations

from datetime import datetime
from fastapi import APIRouter, Query
from app.deps import get_twin_service
from app.models.domain import TraceLatestResponse

router = APIRouter()

@router.get("/latest", response_model=TraceLatestResponse)
async def trace_latest(
    limit: int = Query(60, ge=1, le=200, description="Max number of trace events to return"),
) -> TraceLatestResponse:
    """
    Returns recent explainability events for the Decision Trace timeline panel.
    """
    svc = get_twin_service()
    events = svc.get_trace(limit=limit)

    return TraceLatestResponse(ts=datetime.now().isoformat(), events=events)
