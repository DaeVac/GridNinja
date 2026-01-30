"""
routes_decision.py

Purpose:
  The primary Controller API for the Neural Control Plane.
  Clients call this endpoint to request signed load shifts (export/import).

Endpoints:
  - **GET /decision/latest**: Evaluates a proposed load shift (`deltaP_request_kw`) against:
    1. Grid Capacity (GNN predicted headroom or manual override).
    2. Physical Safety (Thermal limits).
    3. Policy Rules (Battery SOC, Ramp rates).

Contract:
  - **Headroom Source**: If `grid_headroom_kw` is provided, it OVERRIDES the GNN.
    Otherwise, the GNN is queried automatically.
  - **Response**: Returns `DecisionResponse` with `status="APPROVED"` or `"BLOCKED"`,
    along with a structured `trace` explaining the decision chain.
"""
from __future__ import annotations

from fastapi import APIRouter, Query, HTTPException
from typing import Optional, List
from datetime import datetime
from sqlmodel import Session, select
from app.deps import get_twin_service
from app.models.domain import DecisionResponse, DecisionLogResponse, DecisionLogEntry
from app.models.db import engine, DecisionRecord

router = APIRouter()

@router.get("/latest", response_model=DecisionResponse)
async def decision_latest(
    deltaP_request_kw: float = Query(
        ...,
        ge=-5000.0,
        le=5000.0,
        description="Requested load shift (kW). Positive=export, negative=import.",
    ),
    P_site_kw: float = Query(..., ge=0.0, le=100000.0, description="Total site load (kW)"),
    grid_headroom_kw: Optional[float] = Query(None, ge=0.0, le=100000.0, description="Available grid capacity (kW)"),
    horizon_s: int = Query(30, ge=10, le=300, description="Optimization horizon (seconds)"),
    dt_s: int = Query(1, ge=1, le=10, description="Time step (seconds)"),
    ramp_rate_kw_per_s: float = Query(50.0, ge=1.0, le=1000.0, description="Max ramp rate (kW/s)"),
) -> DecisionResponse:
    # 0. Safety Check for NaN/Inf (Pydantic might allow Inf by default for floats)
    import math
    if math.isnan(deltaP_request_kw) or math.isinf(deltaP_request_kw):
        raise HTTPException(status_code=422, detail="Invalid value for deltaP_request_kw")
    # grid_headroom_kw is optional now, check if present
    if grid_headroom_kw is not None and (math.isnan(grid_headroom_kw) or math.isinf(grid_headroom_kw)):
        raise HTTPException(status_code=422, detail="Invalid value for grid_headroom_kw")

    svc = get_twin_service()
    
    # 1. Determine Headroom Source
    headroom_source = "MANUAL"
    if grid_headroom_kw is None:
        headroom_source = "GNN"
        try:
            # Check if GNN is available
            if svc.gnn and svc.gnn.is_ready():
                # Predict safe shift at DC bus (default 18)
                # We assume DC bus is 18 for this topology
                grid_headroom_kw = svc.gnn.predict_safe_shift_kw(
                    target_bus_label=18,
                    dc_bus_label=18,
                    dc_p_kw=P_site_kw
                )
            else:
                 headroom_source = "FALLBACK"
                 grid_headroom_kw = 1500.0
        except Exception as e:
            print(f"[WARN] GNN prediction failed in route: {e}")
            headroom_source = "FALLBACK"
            grid_headroom_kw = 1500.0

    out = svc.decide(
        deltaP_request_kw=deltaP_request_kw,
        P_site_kw=P_site_kw,
        grid_headroom_kw=float(grid_headroom_kw),
        horizon_s=horizon_s,
        dt_s=dt_s,
        ramp_rate_kw_per_s=ramp_rate_kw_per_s,
    )
    
    # Inject traceability
    # 'trace' is a list of dicts. We can add a specialized event or add fields to the top-level response?
    # DecisionResponse is strict. The user said: result.decision_trace["grid_headroom_source"] = ...
    # 'out' is a dict that matches DecisionResponse (or close to it).
    # DecisionResponse definition in domain.py might not have arbitrary dict 'decision_trace'.
    # It has 'trace': List[DecisionTraceEvent].
    # But wait, logic suggests adding "trace visibility".
    # I can add a synthetic trace event to 'trace' list?
    # Or rely on 'debug' / 'meta' field if it exists?
    # Let's verify 'DecisionResponse' schema first? 
    # Actually, the user code is pseudo-code for `result`.
    # `out` is returned as `DecisionResponse(**out)`.
    # I will add a trace event to `out["trace"]` list.
    
    from app.models.domain import DecisionTraceEvent, RuleStatus, SeverityLevel, ComponentType
    from datetime import datetime
    import uuid

    if "trace" in out:
        out["trace"].append({
            "ts": datetime.now().isoformat(),
            "component": "API",
            "rule_id": "HEADROOM_SOURCE",
            "status": RuleStatus.INFO.value,
            "severity": SeverityLevel.LOW.value,
            "message": f"Headroom determined by {headroom_source}",
            "value": float(grid_headroom_kw),
            "threshold": None,
            "phase": "final",
            "decision_id": out.get("decision_id")
        })

    return DecisionResponse(**out)


@router.get("/recent", response_model=DecisionLogResponse)
async def decision_recent(
    limit: int = Query(60, ge=1, le=200, description="Max number of recent decisions to return"),
    coalesce: bool = Query(True, description="Coalesce repeated blocked decisions"),
    window_s: int = Query(90, ge=10, le=600, description="Coalescing window in seconds"),
) -> DecisionLogResponse:
    """
    Returns the most recent controller decisions for the operator log.
    """
    try:
        with Session(engine) as session:
            stmt = select(DecisionRecord).order_by(DecisionRecord.ts.desc()).limit(limit)
            records = session.exec(stmt).all()
    except Exception:
        records = []

    def to_entry(r: DecisionRecord) -> DecisionLogEntry:
        return DecisionLogEntry(
            decision_id=r.decision_id,
            ts=r.ts.isoformat(),
            requested_kw=r.requested_kw,
            approved_kw=r.approved_kw,
            blocked=r.blocked,
            reason_code=r.reason_code,
            primary_constraint=r.primary_constraint,
            constraint_value=r.constraint_value,
            constraint_threshold=r.constraint_threshold,
            confidence=r.confidence,
        )

    if not coalesce:
        items = [to_entry(r) for r in records]
    else:
        items: List[DecisionLogEntry] = []
        for r in records:
            entry = to_entry(r)
            if not entry.blocked:
                entry.count = 1
                entry.first_ts = entry.ts
                entry.last_ts = entry.ts
                items.append(entry)
                continue

            last = items[-1] if items else None
            if (
                last
                and last.blocked
                and last.reason_code == entry.reason_code
                and (last.primary_constraint or "") == (entry.primary_constraint or "")
                and abs(last.requested_kw - entry.requested_kw) < 1e-3
                and last.last_ts
            ):
                delta = abs(
                    datetime.fromisoformat(last.last_ts) - datetime.fromisoformat(entry.ts)
                ).total_seconds()
                if delta <= window_s:
                    last.count = (last.count or 1) + 1
                    last.first_ts = entry.ts
                    last.last_ts = last.last_ts or last.ts
                    continue

            entry.count = 1
            entry.first_ts = entry.ts
            entry.last_ts = entry.ts
            items.append(entry)

    return DecisionLogResponse(ts=datetime.now().isoformat(), items=items)
