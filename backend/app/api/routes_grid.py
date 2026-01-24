from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query
from typing import Optional
from app.schemas.grid import GridTopologyResponse, GridPredictionResponse
from app.services.grid_service_real import GridServiceReal
from app.deps import get_twin_service

router = APIRouter()
grid = GridServiceReal()


@router.get("/topology", response_model=GridTopologyResponse)
async def grid_topology() -> GridTopologyResponse:
    return grid.get_topology()


@router.get("/predict", response_model=GridPredictionResponse)
async def grid_predict(
    node_id: int = Query(18, ge=1, le=33),
) -> GridPredictionResponse:
    twin = get_twin_service()

    # Get latest snapshot to provide context (load, freq, etc)
    # We use get_trace for now as a proxy, or reuse get_timeseries
    # Ideally digital twin should have a lightweight "current_state"
    # Using get_timeseries(window=1) is an efficient way to get "now"
    latest_series = twin.get_timeseries(window_s=5, mode="live")
    
    if not latest_series:
        raise HTTPException(status_code=503, detail="No telemetry available")
    
    latest = latest_series[-1] 

    return grid.predict_node(node_id=node_id, latest_telemetry=latest)
