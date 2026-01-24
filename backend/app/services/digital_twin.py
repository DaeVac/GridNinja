from __future__ import annotations

import math
import random
import uuid
from collections import deque
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional

from app.models.domain import (
    DecisionTraceEvent,
    ThermalTwinConfig,
    ThermalTwinState,
)
from app.services.physics_engine import ThermalTwin
from app.services.policy_engine import build_ramp_plan

# Optional dependencies
try:
    from app.services.gnn_service import GNNHeadroomService
except Exception:
    GNNHeadroomService = None  # type: ignore

try:
    from app.services.carbon_service import CarbonService
except Exception:
    CarbonService = None  # type: ignore


# ============================================================
# KPI UTILS
# ============================================================

def _parse_iso(ts: str) -> Optional[datetime]:
    try:
        return datetime.fromisoformat(ts)
    except Exception:
        return None

def compute_trace_kpis(events: List[Dict[str, Any]], window_s: int = 900) -> Dict[str, Any]:
    """
    Derives KPIs from trace events in the last window_s seconds.
    """
    now = datetime.now()
    cutoff = now - timedelta(seconds=int(window_s))

    recent: List[Dict[str, Any]] = []
    for e in events:
        dt = _parse_iso(str(e.get("ts", "")))
        if dt is None:
            continue
        if dt >= cutoff:
            recent.append(e)

    blocked = [e for e in recent if e.get("status") == "BLOCKED"]

    blocked_decisions = set()
    for e in blocked:
        did = e.get("decision_id")
        if did:
            blocked_decisions.add(did)

    by_component: Dict[str, int] = {}
    by_rule: Dict[str, int] = {}

    for e in blocked:
        c = str(e.get("component", "UNKNOWN"))
        r = str(e.get("rule_id", "UNKNOWN"))
        by_component[c] = by_component.get(c, 0) + 1
        by_rule[r] = by_rule.get(r, 0) + 1

    return {
        "window_s": int(window_s),
        "unsafe_actions_prevented_total": int(len(blocked)),
        "blocked_decisions_unique": int(len(blocked_decisions)),
        "unsafe_prevented_by_component": by_component,
        "unsafe_prevented_by_rule": by_rule,
    }


# ============================================================
# DIGITAL TWIN SERVICE
# ============================================================

class DigitalTwinService:
    """
    Orchestrates:
      - Physics (ThermalTwin)
      - Policy (Ramp Planner)
      - Decision Trace persistence
      - KPI summary rollups
      - Optional: GNN headroom + carbon signals
    """

    def __init__(
        self,
        gnn: Optional["GNNHeadroomService"] = None,
        carbon: Optional["CarbonService"] = None,
    ):
        # State
        self.therm_cfg = ThermalTwinConfig()
        self.therm_state = ThermalTwinState(T_c=42.0, P_cool_kw=800.0)
        
        # We don't keep a persistent 'twin' object for simulation step-by-step 
        # because the current architecture only simulates 'what-if' scenarios in decide().
        # but get_history generates synthetic data based on this state.

        # Trace Buffer
        self.trace = deque(maxlen=600)

        # Optional services
        self.gnn = gnn
        self.carbon = carbon

    # -----------------------------
    # Trace Buffer Access
    # -----------------------------
    def push_trace(self, e: DecisionTraceEvent | Dict[str, Any]) -> None:
        if isinstance(e, DecisionTraceEvent):
            self.trace.append(e.model_dump())
        else:
            try:
                self.trace.append(DecisionTraceEvent(**e).model_dump())
            except Exception:
                self.trace.append(dict(e))

    def get_trace(self, limit: int = 60) -> List[Dict[str, Any]]:
        limit = max(1, min(200, int(limit)))
        return list(self.trace)[-limit:]

    # -----------------------------
    # State Access
    # -----------------------------
    def get_current_thermal_state(self) -> ThermalTwinState:
        return self.therm_state

    # -----------------------------
    # Telemetry Generation
    # -----------------------------
    def get_timeseries(self, window_s: int = 900, end_ts: Optional[str] = None) -> List[Dict[str, Any]]:
        """
        Generates 'live-looking' telemetry. Returns 60 points for charts.
        """
        # Logic ported from core_logic.DataCenterTwin.get_history
        now = datetime.now()
        window_s = max(60, int(window_s))
        num_points = 60
        step_size = max(1, window_s // num_points)

        # Start from current thermal state
        temp = float(self.therm_state.T_c)
        cooling = float(self.therm_state.P_cool_kw)

        out: List[Dict[str, Any]] = []
        prev_freq = 60.0

        for i in range(num_points):
            t = now - timedelta(seconds=(window_s - (i * step_size)))

            # Grid frequency simulation
            base_freq = 60.0
            dip = (25 <= i <= 35)
            noise = random.uniform(-0.02, 0.02)
            freq = (base_freq - 0.15 + noise) if dip else (base_freq + noise)

            rocof = (freq - prev_freq) / float(step_size)
            prev_freq = freq

            stress = 0.85 if dip else 0.10

            # IT load
            base_load = 1000.0
            it_load = base_load + random.uniform(-15, 15)

            # Carbon intensity
            carbon_val = 450.0 + (math.sin(i / 9.0) * 50.0)
            if self.carbon is not None:
                # Use real carbon service if available
                try:
                    carbon_val = float(self.carbon.get_intensity_g_per_kwh(t))
                except Exception:
                    pass

            # Thermal prediction for this point
            sim_state = ThermalTwinState(T_c=temp, P_cool_kw=cooling)
            sim_twin = ThermalTwin(self.therm_cfg, sim_state)
            pred = sim_twin.predict(it_load, dt_s=float(step_size))

            temp = pred["rack_temp_c_next"]
            cooling = pred["cooling_kw_next"]

            # Safe shift (GNN placeholder or real)
            safe_shift = 1200.0
            if temp > (self.therm_cfg.T_max - 2.0):
                safe_shift = 800.0
            if dip:
                safe_shift = min(safe_shift, 900.0)
            
            # TODO: Integrate GNN if available
            # if self.gnn and self.gnn.is_ready(): ...

            out.append({
                "ts": t.isoformat(),
                "frequency_hz": float(freq),
                "rocof_hz_s": float(rocof),
                "stress_score": float(stress),
                "total_load_kw": float(it_load),
                "safe_shift_kw": float(safe_shift),
                "carbon_g_per_kwh": float(carbon_val),
                "rack_temp_c": float(temp),
                "cooling_kw": float(cooling),
            })
        
        return out

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
        Runs the constraint pipeline.
        """
        decision_id = str(uuid.uuid4())
        trace: List[Dict[str, Any]] = []

        current_state = self.get_current_thermal_state()

        approved_kw, plan, pred = build_ramp_plan(
            P_site_kw=P_site_kw,
            grid_headroom_kw=grid_headroom_kw,
            cfg=self.therm_cfg,
            state=current_state,
            deltaP_request_kw=deltaP_request_kw,
            horizon_s=horizon_s,
            dt_s=dt_s,
            ramp_rate_kw_per_s=ramp_rate_kw_per_s,
            trace_sink=trace,
            decision_id=decision_id,
        )

        # Persist trace
        for e in trace:
            self.push_trace(DecisionTraceEvent(**e))

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
    # KPI Summary
    # -----------------------------
    def get_kpi_summary(self, window_s: int = 900) -> Dict[str, Any]:
        events = list(self.trace)
        return compute_trace_kpis(events, window_s=window_s)
