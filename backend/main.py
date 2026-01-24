# main.py
from __future__ import annotations

import os
import uuid
from datetime import datetime
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

# ------------------------------------------------------------
# Imports from your physics engine / twin module
# ------------------------------------------------------------
try:
    from core_logic import (
        DataCenterTwin,
        build_ramp_plan,
        DecisionTraceEvent,
        compute_trace_kpis,
    )
except Exception as e:
    raise RuntimeError(
        "Failed to import core_logic.py. Make sure core_logic.py is in the same folder as main.py "
        "and contains DataCenterTwin + build_ramp_plan + DecisionTraceEvent + compute_trace_kpis."
    ) from e


# ============================================================
# 1) API SCHEMAS (Backend -> Frontend Contract)
# ============================================================

class TelemetryTimeseriesPoint(BaseModel):
    ts: str

    frequency_hz: float
    rocof_hz_s: float
    stress_score: float

    total_load_kw: float
    safe_shift_kw: float

    carbon_g_per_kwh: float

    rack_temp_c: float
    cooling_kw: float


class RampPlanStep(BaseModel):
    t_offset_s: int
    proposed_deltaP_kw: float

    rack_temp_c: float
    cooling_kw: float

    thermal_ok: bool
    thermal_headroom_kw: float
    reason: str


class RampPlan(BaseModel):
    requested_deltaP_kw: float
    approved_deltaP_kw: float
    blocked: bool
    reason: str
    steps: List[RampPlanStep] = Field(default_factory=list)


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


class TraceLatestResponse(BaseModel):
    ts: str
    events: List[Dict[str, Any]]


class KpiSummary(BaseModel):
    window_s: int
    unsafe_actions_prevented_total: int
    blocked_decisions_unique: int
    unsafe_prevented_by_component: Dict[str, int]
    unsafe_prevented_by_rule: Dict[str, int]


class HealthResponse(BaseModel):
    status: str
    ts: str


# ============================================================
# 2) FASTAPI APP SETUP
# ============================================================

app = FastAPI(
    title="GridNinja Backend",
    version="0.1.0",
    description="Physics-informed control plane for Smart Grid + Data Center operations (hackathon build).",
)

# CORS: allow local Next.js dev + hackathon flexibility
ALLOWED_ORIGINS = os.getenv("ALLOWED_ORIGINS", "*")
allow_origins = ["*"] if ALLOWED_ORIGINS == "*" else [o.strip() for o in ALLOWED_ORIGINS.split(",")]

app.add_middleware(
    CORSMiddleware,
    allow_origins=allow_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Global twin instance (shared state for demo)
dc_twin = DataCenterTwin()


# ============================================================
# 3) UTILS
# ============================================================

def _safe_now_iso() -> str:
    return datetime.now().isoformat()


def _persist_trace_events(events: List[Dict[str, Any]]) -> None:
    """
    Persist trace events into the DataCenterTwin ring buffer.
    This assumes dc_twin exposes push_trace() and get_trace().
    """
    for e in events:
        # Ensure pydantic validation (keeps trace clean)
        model = DecisionTraceEvent(**e)

        # core_logic.py patch uses dc_twin.push_trace(model)
        # but we’ll tolerate either push_trace(dict) or push_trace(model)
        if hasattr(dc_twin, "push_trace"):
            try:
                dc_twin.push_trace(model)  # preferred
            except TypeError:
                dc_twin.push_trace(model.model_dump())  # fallback
        else:
            # If no trace buffer, do nothing (shouldn't happen in our architecture)
            pass


# ============================================================
# 4) ROUTES
# ============================================================

@app.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    return HealthResponse(status="ok", ts=_safe_now_iso())


@app.get("/telemetry/timeseries", response_model=List[TelemetryTimeseriesPoint])
async def telemetry_timeseries(
    window_s: int = Query(900, ge=60, le=3600, description="Lookback window in seconds"),
    end_ts: Optional[str] = Query(
        None,
        description="Optional replay end timestamp (ISO). If provided, backend may return historical slice.",
    ),
) -> List[TelemetryTimeseriesPoint]:
    """
    Returns timeseries data for charts.
    LIVE mode: end_ts is None, data is 'now-relative'
    REPLAY mode: end_ts provided (hackathon: accepted but may be ignored)
    """
    # Hackathon: DataCenterTwin currently generates live-looking data
    # You can extend it later to honor end_ts.
    raw = dc_twin.get_history(window_s=window_s)

    # Validate/normalize output for frontend stability
    out: List[TelemetryTimeseriesPoint] = []
    for r in raw:
        out.append(TelemetryTimeseriesPoint(**r))
    return out


@app.get("/decision/latest", response_model=DecisionResponse)
async def decision_latest(
    deltaP_request_kw: float = Query(300.0, ge=0.0, le=5000.0, description="Requested additional power shift (kW)"),
    P_site_kw: float = Query(1000.0, ge=0.0, le=10000.0, description="Current site load (kW)"),
    grid_headroom_kw: float = Query(1500.0, ge=0.0, le=10000.0, description="Grid-allowed headroom (kW)"),
    horizon_s: int = Query(30, ge=5, le=300, description="Ramp planning horizon (seconds)"),
    dt_s: int = Query(1, ge=1, le=10, description="Ramp simulation timestep (seconds)"),
    ramp_rate_kw_per_s: float = Query(50.0, ge=1.0, le=1000.0, description="ΔP ramp rate limit (kW/s)"),
) -> DecisionResponse:
    """
    Core control endpoint. Returns:
      - approved ΔP
      - blocked/allowed
      - ramp plan steps
      - explainability trace
    """
    decision_id = str(uuid.uuid4())
    trace: List[Dict[str, Any]] = []

    current_state = dc_twin.get_current_thermal_state()

    approved_kw, plan, pred = build_ramp_plan(
        P_site_kw=P_site_kw,
        grid_headroom_kw=grid_headroom_kw,
        cfg=dc_twin.therm_cfg,
        state=current_state,
        deltaP_request_kw=deltaP_request_kw,
        horizon_s=horizon_s,
        dt_s=dt_s,
        ramp_rate_kw_per_s=ramp_rate_kw_per_s,
        trace_sink=trace,
        decision_id=decision_id,
    )

    # persist trace into ring buffer
    _persist_trace_events(trace)

    return DecisionResponse(
        ts=_safe_now_iso(),
        decision_id=decision_id,
        requested_deltaP_kw=float(deltaP_request_kw),
        approved_deltaP_kw=float(approved_kw),
        blocked=bool(plan.blocked),
        reason=str(plan.reason),
        plan=plan.model_dump() if hasattr(plan, "model_dump") else dict(plan),
        trace=trace,
        prediction_debug=pred if isinstance(pred, dict) else None,
    )


@app.get("/trace/latest", response_model=TraceLatestResponse)
async def trace_latest(
    limit: int = Query(60, ge=1, le=200, description="Max number of trace events to return"),
) -> TraceLatestResponse:
    """
    Returns recent explainability events for the Decision Trace timeline panel.
    """
    if hasattr(dc_twin, "get_trace"):
        events = dc_twin.get_trace(limit=limit)
    else:
        events = []

    return TraceLatestResponse(ts=_safe_now_iso(), events=events)


@app.get("/kpi/summary", response_model=KpiSummary)
async def kpi_summary(
    window_s: int = Query(900, ge=60, le=3600, description="KPI aggregation window"),
) -> KpiSummary:
    """
    Computes KPI rollups from trace events for the dashboard tiles.
    Example: Unsafe actions prevented (count of BLOCKED trace events).
    """
    # Prefer dc_twin.get_kpi_summary() if you implemented it; otherwise compute here.
    if hasattr(dc_twin, "get_kpi_summary"):
        k = dc_twin.get_kpi_summary(window_s=window_s)
    else:
        events = list(getattr(dc_twin, "trace", []))
        k = compute_trace_kpis(events, window_s=window_s)

    return KpiSummary(**k)


# ============================================================
# 5) LOCAL RUN INSTRUCTIONS
# ============================================================
# Run:
#   uvicorn main:app --reload --port 8000
#
# Open docs:
#   http://localhost:8000/docs
#
# Frontend calls:
#   http://localhost:8000/telemetry/timeseries?window_s=900
#   http://localhost:8000/decision/latest?deltaP_request_kw=300
#   http://localhost:8000/trace/latest?limit=60
#   http://localhost:8000/kpi/summary?window_s=900
