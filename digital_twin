# apps/backend/app/services/digital_twin.py
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Dict, List, Optional

from core.core_logic import (
    DataCenterTwin,
    DecisionTraceEvent,
    build_ramp_plan,
    compute_trace_kpis,
)

# Optional dependencies (safe if you don't use them yet)
try:
    from app.services.gnn_service import GNNHeadroomService
except Exception:
    GNNHeadroomService = None  # type: ignore

try:
    from app.services.carbon_service import CarbonService
except Exception:
    CarbonService = None  # type: ignore


class DigitalTwinService:
    """
    Orchestrates:
      - DataCenterTwin (physics)
      - Ramp Planner (constraint policy)
      - Decision Trace persistence
      - KPI summary rollups
      - Optional: GNN headroom + carbon signals
    """

    def __init__(
        self,
        twin: Optional[DataCenterTwin] = None,
        gnn: Optional["GNNHeadroomService"] = None,
        carbon: Optional["CarbonService"] = None,
    ):
        self.twin = twin or DataCenterTwin()

        # Optional services
        self.gnn = gnn
        self.carbon = carbon

    # -----------------------------
    # Telemetry
    # -----------------------------
    def get_timeseries(self, window_s: int = 900, end_ts: Optional[str] = None) -> List[Dict[str, Any]]:
        """
        Returns timeseries points for charts.
        end_ts is reserved for REPLAY mode (optional).
        For hackathon, you can ignore end_ts and generate now-relative series.
        """
        points = self.twin.get_history(window_s=window_s)

        # Optionally override carbon intensity if you want a separate carbon service
        if self.carbon is not None:
            for p in points:
                # If ts is missing, use now
                try:
                    t = datetime.fromisoformat(p["ts"])
                except Exception:
                    t = datetime.now()
                p["carbon_g_per_kwh"] = float(self.carbon.get_intensity_g_per_kwh(t))

        # Optionally override safe_shift_kw using GNN inference (advanced)
        # This requires you to define/compute node features; for hackathon, skip.
        # if self.gnn is not None and self.gnn.is_ready():
        #     p["safe_shift_kw"] = self.gnn.predict_safe_shift_kw(node_features)

        return points

    # -----------------------------
    # Decisions
    # -----------------------------
    def decide(
        self,
        deltaP_request_kw: float,
        P_site_kw: float,
        grid_headroom_kw: float,
        horizon_s: int = 30,
        dt_s: int = 1,
        ramp_rate_kw_per_s: float = 50.0,
    ) -> Dict[str, Any]:
        """
        Runs the constraint pipeline and returns the UI contract:
          - approved_kw
          - plan
          - trace
          - reason codes
        """
        decision_id = str(uuid.uuid4())
        trace: List[Dict[str, Any]] = []

        current_state = self.twin.get_current_thermal_state()

        approved_kw, plan, pred = build_ramp_plan(
            P_site_kw=P_site_kw,
            grid_headroom_kw=grid_headroom_kw,
            cfg=self.twin.therm_cfg,
            state=current_state,
            deltaP_request_kw=deltaP_request_kw,
            horizon_s=horizon_s,
            dt_s=dt_s,
            ramp_rate_kw_per_s=ramp_rate_kw_per_s,
            trace_sink=trace,
            decision_id=decision_id,
        )

        # Persist trace into twin ring buffer
        for e in trace:
            # validate shape with DecisionTraceEvent
            self.twin.push_trace(DecisionTraceEvent(**e))

        return {
            "ts": datetime.now().isoformat(),
            "decision_id": decision_id,
            "requested_deltaP_kw": float(deltaP_request_kw),
            "approved_deltaP_kw": float(approved_kw),
            "blocked": bool(plan.blocked),
            "reason": str(plan.reason),
            "plan": plan.model_dump() if hasattr(plan, "model_dump") else dict(plan),
            "trace": trace,
            "prediction_debug": pred if isinstance(pred, dict) else None,
        }

    # -----------------------------
    # Trace + KPIs
    # -----------------------------
    def get_trace(self, limit: int = 60) -> List[Dict[str, Any]]:
        return self.twin.get_trace(limit=limit)

    def get_kpi_summary(self, window_s: int = 900) -> Dict[str, Any]:
        events = list(self.twin.trace) if hasattr(self.twin, "trace") else []
        return compute_trace_kpis(events, window_s=window_s)
