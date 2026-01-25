from __future__ import annotations

from typing import List, Optional
from fastapi import APIRouter, Query

from app.deps import get_twin_service
from app.models.domain import TelemetryTimeseriesPoint

from sse_starlette.sse import EventSourceResponse
import asyncio
import json

router = APIRouter()

@router.get("/timeseries", response_model=List[TelemetryTimeseriesPoint])
async def telemetry_timeseries(
    window_s: int = Query(900, ge=60, le=3600, description="Lookback window (seconds)"),
    end_ts: Optional[str] = Query(None, description="Optional REPLAY end timestamp (ISO)"),
    mode: str = Query("live", pattern="^(live|replay)$", description="Mode: live or replay"),
) -> List[TelemetryTimeseriesPoint]:
    svc = get_twin_service()
    points = svc.get_timeseries(window_s=window_s, end_ts=end_ts, mode=mode)

    # enforce typed output (keeps schema stable)
    return [TelemetryTimeseriesPoint(**p) for p in points]


@router.get("/stream", response_class=EventSourceResponse)
async def telemetry_stream():
    """
    Streams the latest telemetry point every 1s (SSE).
    """
    svc = get_twin_service()
    
    async def event_generator():
        while True:
            # Use cached latest point for efficiency (avoids recomputing full timeseries)
            latest = svc.get_latest_telemetry()
            if latest:
                yield {"data": json.dumps(latest)}
            
            await asyncio.sleep(1.0)

    return EventSourceResponse(event_generator())
