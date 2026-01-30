"""
routes_grid.py

Purpose:
  Exposes Grid Awareness capabilities: Topology, Real-time Awareness, and Prediction.

Endpoints:
  - **GET /grid/topology**: Returns the static IEEE-33 network graph (Nodes/Edges).
    Used by the frontend Visualizer to render the "map".
  - **GET /grid/predict**: Running "What-if" analysis for a specific node.
    It asks the GNN: "How much power can I safely add at Node X right now?"

Dependencies:
  - `GridServiceReal` (Production) backed by Pandapower foundation.
  - `DigitalTwin` (for current telemetry context like total load).
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query
from typing import Optional
from sqlmodel import Session, select
from app.schemas.grid import GridTopologyResponse, GridPredictionResponse
from app.services.grid_service_real import GridServiceReal
from app.deps import get_twin_service
from app.models.db import engine, DecisionRecord

router = APIRouter()
grid = GridServiceReal()


@router.get("/topology", response_model=GridTopologyResponse)
async def grid_topology() -> GridTopologyResponse:
    alleviation_text: Optional[str] = None

    try:
        with Session(engine) as session:
            stmt = select(DecisionRecord).order_by(DecisionRecord.ts.desc()).limit(1)
            record = session.exec(stmt).first()
            if record is not None:
                approved_kw = float(record.approved_kw)
                requested_kw = float(record.requested_kw)
                direction = "export" if approved_kw >= 0 else "import"
                magnitude = abs(approved_kw)
                status = "BLOCKED" if record.blocked else "ALLOWED"
                if not record.blocked and abs(approved_kw) + 1e-6 < abs(requested_kw):
                    status = "CLIPPED"
                reason = record.reason_code or "OK"
                alleviation_text = (
                    f"{status}: controller recommends {direction} {magnitude:.0f} kW "
                    f"(reason: {reason})."
                )
    except Exception:
        alleviation_text = None

    return grid.get_topology(alleviation_text=alleviation_text)


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


@router.get("/gnn/health")
async def gnn_health():
    return grid.get_gnn_health()
