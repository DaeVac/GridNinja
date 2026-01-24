from __future__ import annotations

from typing import List, Optional
from fastapi import APIRouter, Query

from app.deps import get_twin_service
from app.models.domain import TelemetryTimeseriesPoint

router = APIRouter()

@router.get("/timeseries", response_model=List[TelemetryTimeseriesPoint])
async def telemetry_timeseries(
    window_s: int = Query(900, ge=60, le=3600, description="Lookback window (seconds)"),
    end_ts: Optional[str] = Query(None, description="Optional REPLAY end timestamp (ISO)"),
    mode: str = Query("live", regex="^(live|replay)$", description="Mode: live or replay"),
) -> List[TelemetryTimeseriesPoint]:
    svc = get_twin_service()
    points = svc.get_timeseries(window_s=window_s, end_ts=end_ts, mode=mode)

    # enforce typed output (keeps schema stable)
    return [TelemetryTimeseriesPoint(**p) for p in points]
