from __future__ import annotations

from fastapi import APIRouter, Query, HTTPException
from app.deps import get_twin_service
from app.models.domain import DecisionResponse

router = APIRouter()

@router.get("/latest", response_model=DecisionResponse)
async def decision_latest(
    deltaP_request_kw: float = Query(..., ge=-5000.0, le=5000.0, description="Requested load shift (kW)"),
    P_site_kw: float = Query(..., ge=0.0, le=100000.0, description="Total site load (kW)"),
    grid_headroom_kw: float = Query(..., ge=0.0, le=100000.0, description="Available grid capacity (kW)"),
    horizon_s: int = Query(30, ge=10, le=300, description="Optimization horizon (seconds)"),
    dt_s: int = Query(1, ge=1, le=10, description="Time step (seconds)"),
    ramp_rate_kw_per_s: float = Query(50.0, ge=1.0, le=1000.0, description="Max ramp rate (kW/s)"),
) -> DecisionResponse:
    # 0. Safety Check for NaN/Inf (Pydantic might allow Inf by default for floats)
    import math
    if math.isnan(deltaP_request_kw) or math.isinf(deltaP_request_kw):
        raise HTTPException(status_code=422, detail="Invalid value for deltaP_request_kw")
    if math.isnan(grid_headroom_kw) or math.isinf(grid_headroom_kw):
        raise HTTPException(status_code=422, detail="Invalid value for grid_headroom_kw")
    svc = get_twin_service()

    out = svc.decide(
        deltaP_request_kw=deltaP_request_kw,
        P_site_kw=P_site_kw,
        grid_headroom_kw=grid_headroom_kw,
        horizon_s=horizon_s,
        dt_s=dt_s,
        ramp_rate_kw_per_s=ramp_rate_kw_per_s,
    )

    return DecisionResponse(**out)
