"""
digital_twin.py

Purpose:
  Orchestrates the digital twin simulation, managing the state of the data center,
  executing physics steps, and applying policy decisions. It serves as the
  "engine room" that connects telemetry, physics, and decision-making logic.

Key Responsibilities:
  - **State Management**: Maintains the current thermal, power, and battery state.
  - **Simulation**: Advances the physics model in discrete time steps (`dt_s`).
  - **Telemetry Generation**: Produces live or replayed telemetry data for the frontend.
  - **Decision Integration**: Calls the `PolicyEngine` to validate requests and the `GNNService` (optional) for grid awareness.

Flow:
  1. `tick()`: Advances time, updates physics (`ThermalTwin`), and emits telemetry.
  2. `decide()`: Takes a load shift request, fuses constraints (Grid, Thermal, Policy), and returns an approved plan.
"""
from __future__ import annotations

import math
import random
import uuid
from collections import deque
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional
from collections import Counter
import torch

from app.models.domain import (
    DecisionTraceEvent,
    ThermalTwinConfig,
    ThermalTwinState,
    ComponentType,
    RuleStatus,
    SeverityLevel
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

    blocked = [e for e in recent if e.get("status") == RuleStatus.BLOCKED.value]

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

    # New Metrics
    total_recent = len(set(e.get("decision_id") for e in recent if e.get("decision_id")))
    blocked_rate_pct = (len(blocked_decisions) / total_recent * 100.0) if total_recent > 0 else 0.0

    # Top blocked rules
    top_rules = [r for r, _ in Counter(by_rule).most_common(3)]
    
    # Financial & Environmental Calcs (Simulated Estimate)
    # We iterate over unique decisions to sum up approved kW vs requested
    # Note: `events` are trace items. We need to aggregate by decision_id first to get the main 'approved_deltaP_kw'
    # But trace items check specific rules. The 'APPROVED_DELTA_SELECTED' rule contains the final math.
    
    total_kwh_shifted = 0.0
    total_blocked_requests = len(blocked_decisions)
    
    # Simple proxy: sum up 'approved_deltaP_kw' from "APPROVED_DELTA_SELECTED" events
    for e in recent:
        if e.get("rule_id") == "APPROVED_DELTA_SELECTED":
             kw = float(e.get("approved_deltaP_kw", 0.0))
             # Assume this shift lasts for the decision horizon (avg 30s)
             total_kwh_shifted += (kw * (30.0 / 3600.0))
    
    # Formulas (Projected for Demo)
    # $0.15/kWh difference between peak and off-peak
    money_saved_usd = total_kwh_shifted * 0.15 
    
    # 0.4 kgCO2/kWh (grid avg)
    co2_avoided_kg = total_kwh_shifted * 0.4
    
    # SLA Penalty: $500 per blocked job
    sla_penalty_usd = total_blocked_requests * 500.0
    
    # Jobs on time
    jobs_on_time_pct = 100.0 - blocked_rate_pct

    return {
        "window_s": int(window_s),
        "unsafe_actions_prevented_total": int(len(blocked)),
        "blocked_decisions_unique": int(len(blocked_decisions)),
        "blocked_rate_pct": float(round(blocked_rate_pct, 1)),
        "jobs_completed_on_time_pct": float(round(jobs_on_time_pct, 1)),
        "money_saved_usd": float(round(money_saved_usd, 2)),
        "co2_avoided_kg": float(round(co2_avoided_kg, 2)),
        "sla_penalty_usd": float(round(sla_penalty_usd, 2)),
        "top_blocked_rules": top_rules,
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
        
        # Trace Buffer
        self.trace = deque(maxlen=600)

        # Optional services
        self.gnn = gnn
        self.carbon = carbon
        
        # Latest telemetry point (for WebSockets)
        self._latest: Optional[Dict[str, Any]] = None

    def get_latest_telemetry(self) -> Optional[Dict[str, Any]]:
        return self._latest

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
    def get_timeseries(self, window_s: int = 900, end_ts: Optional[str] = None, mode: str = "live") -> List[Dict[str, Any]]:
        """
        Generates telemetry. 
        Mode 'live': uses seeded randomness + current state.
        Mode 'replay': queries DB for decisions around the window to influence the "simulated" past.
        """
        now = datetime.now()
        if end_ts and mode == "replay":
            try:
                now = datetime.fromisoformat(end_ts)
            except:
                pass

        window_s = max(60, int(window_s))
        num_points = 60
        step_size = max(1, window_s // num_points)

        # Seed based on minute resolution
        seed_val = int(now.timestamp() / 60) 
        rng = random.Random(seed_val)

        # Determine start state for simulation
        # In a real replay, we'd fetch the exact persisted state at (now - window).
        # Here we approximate:
        temp = float(self.therm_state.T_c)
        cooling = float(self.therm_state.P_cool_kw)
        
        # If replay, we could fetch decisions in this window to overlay "real" choices vs synthetic
        # For this MVP, we will stick to the deterministic aesthetic simulation but time-shifted.
        
        out: List[Dict[str, Any]] = []
        prev_freq = 60.0

        for i in range(num_points):
            t = now - timedelta(seconds=(window_s - (i * step_size)))

            # Grid frequency simulation
            base_freq = 60.0
            dip = (25 <= i <= 35)
            noise = rng.uniform(-0.02, 0.02)
            freq = (base_freq - 0.15 + noise) if dip else (base_freq + noise)

            rocof = (freq - prev_freq) / float(step_size)
            prev_freq = freq

            stress = 0.85 if dip else 0.10

            # IT load
            base_load = 1000.0
            it_load = base_load + rng.uniform(-15, 15)

            # Carbon intensity
            carbon_val = 450.0 + (math.sin(i / 9.0) * 50.0)
            if self.carbon is not None:
                try:
                    carbon_val = float(self.carbon.get_intensity_g_per_kwh(t))
                except Exception:
                    pass

            # Thermal prediction for this point (what-if history)
            sim_state = ThermalTwinState(T_c=temp, P_cool_kw=cooling)
            sim_twin = ThermalTwin(self.therm_cfg, sim_state)
            pred = sim_twin.predict(it_load, dt_s=float(step_size))

            temp = pred["rack_temp_c_next"]
            cooling = pred["cooling_kw_next"]

            # Default safe shift (fallback)
            safe_shift = 1200.0
            if temp > (self.therm_cfg.T_max - 2.0):
                safe_shift = 800.0
            if dip:
                safe_shift = min(safe_shift, 900.0)

            if self.gnn and self.gnn.is_ready():
                 # 1. Synthesize random grid state: (33, 3) tensor
                 # Features: [P_load_MW, Q_load_MVAR, P_gen_MW]
                 # We vary P_load based on our "it_load" simulation + noise
                 
                 # Base standard loads (randomized roughly around 1.0 pu)
                 # We create a random tensor on CPU, then let service handle device
                 x_node = torch.zeros(33, 3)
                 
                 # Randomize loads (cols 0, 1) roughly 0.1 +/- 0.05 MW per node
                 # This mimics a distribution feeder
                 x_node[:, 0] = torch.rand(33) * 0.2  # P_load
                 x_node[:, 1] = x_node[:, 0] * 0.3    # Q_load ~ 0.3 PF
                 
                 # Inject our specific site load at the DC bus (approx bus 17)
                 # DC load is in kW, convert to MW
                 dc_load_mw = it_load / 1000.0
                 x_node[17, 0] = float(dc_load_mw)
                 
                 # Predict safe shift
                 # We wrap in try/except to avoid crashing the demo if GNN fails
                 try:
                     pred_shift_kw = self.gnn.predict_safe_shift_kw(x_node)
                     safe_shift = pred_shift_kw
                 except Exception:
                     pass
            
            # The else block for heuristics is now covered by the default initialization above


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
        Commits successful plans to persistent state.
        """
        decision_id = str(uuid.uuid4())
        trace: List[Dict[str, Any]] = []

        # ==================================
        # GNN HEADROOM CHECK
        # ==================================
        # If GNN is active, we ask it for the "safe headroom" and clamp the grid_headroom
        # This prevents the heuristic/static limit from being the only guardrail.
        gnn_limit_kw = None
        if self.gnn and self.gnn.is_ready():
            try:
                 x_node = torch.zeros(33, 3)
                 x_node[:, 0] = torch.rand(33) * 0.2
                 x_node[:, 1] = x_node[:, 0] * 0.3
                 
                 # Inject current actual site load
                 dc_load_mw = P_site_kw / 1000.0
                 x_node[17, 0] = float(dc_load_mw)
                 
                 gnn_limit_kw = self.gnn.predict_safe_shift_kw(x_node)
            except Exception as e:
                print(f"[WARN] GNN inference failed: {e}")
        
        effective_headroom = grid_headroom_kw
        if gnn_limit_kw is not None:
            # Check if GNN is stricter
            if gnn_limit_kw < grid_headroom_kw:
                effective_headroom = gnn_limit_kw
                trace.append({
                    "ts": datetime.now().isoformat(),
                    "component": ComponentType.GNN.value if hasattr(ComponentType, "GNN") else "GNN",
                    "rule_id": "GNN_HEADROOM_CAP",
                    "status": RuleStatus.INFO.value,
                    "severity": SeverityLevel.LOW.value,
                    "message": f"GNN clamped grid headroom from {grid_headroom_kw} to {gnn_limit_kw:.2f} kW",
                    "value": float(gnn_limit_kw),
                    "threshold": float(grid_headroom_kw),
                    "decision_id": decision_id,
                })

        current_state = self.get_current_thermal_state()

        approved_kw, plan, pred = build_ramp_plan(
            P_site_kw=P_site_kw,
            grid_headroom_kw=effective_headroom,
            cfg=self.therm_cfg,
            state=current_state,
            deltaP_request_kw=deltaP_request_kw,
            horizon_s=horizon_s,
            dt_s=dt_s,
            ramp_rate_kw_per_s=ramp_rate_kw_per_s,
            trace_sink=trace,
            decision_id=decision_id,
        )

        # PERSISTENT STATE UPDATE & DB LOGGING
        # 1. Update Thermal State
        if not plan.blocked and len(plan.steps) > 0:
            first_step = plan.steps[0]
            self.therm_state.T_c = first_step.rack_temp_c
            self.therm_state.P_cool_kw = first_step.cooling_kw

        # Prepare output dictionary
        out = {
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

        # 2. Persist to DB
        from sqlmodel import Session
        from app.models.db import engine, DecisionRecord, TraceRecord

        try:
            with Session(engine) as session:
                # Create Decision Record
                dr = DecisionRecord(
                    decision_id=decision_id,
                    ts=datetime.fromisoformat(out["ts"]),
                    
                    requested_kw=float(deltaP_request_kw),
                    site_load_kw=float(P_site_kw),
                    grid_headroom_kw=float(grid_headroom_kw),
                    
                    approved_kw=float(approved_kw),
                    blocked=bool(plan.blocked),
                    reason_code=str(plan.reason),
                    
                    primary_constraint=str(plan.primary_constraint.value) if plan.primary_constraint else None,
                    constraint_value=float(plan.constraint_value) if plan.constraint_value is not None else None,
                    constraint_threshold=float(plan.constraint_threshold) if plan.constraint_threshold is not None else None,
                )
                session.add(dr)
                # Need to commit/refresh to get ID if needed, 
                # but we can rely on relationship auto-persistence if we add traces to `dr` 
                # or add them separately linked by `decision_id`
                
                # Bulk create traces
                for e in trace:
                    tr = TraceRecord(
                        decision_id=decision_id,
                        ts=datetime.fromisoformat(e["ts"]),
                        component=str(e["component"]),
                        rule_id=str(e["rule_id"]),
                        status=str(e["status"]),
                        severity=str(e["severity"]),
                        message=str(e["message"]),
                        value=float(e["value"]) if e.get("value") is not None else None,
                        threshold=float(e["threshold"]) if e.get("threshold") is not None else None,
                    )
                    session.add(tr)
                
                session.commit()
        except Exception as ex:
            print(f"[ERROR] Failed to persist decision: {ex}")

        # Persist trace to memory buffer (for immediate UI view)
        for e in trace:
            self.push_trace(DecisionTraceEvent(**e))

        return out

    # -----------------------------
    # Tick Loop (Background Sim)
    # -----------------------------
    def tick(self, dt_s: float = 1.0):
        """
        Called by background loop to advance physics.
        Simulates passive thermal drift based on current cooling vs "base" load.
        """
        # 1. Simulate a random walk for IT load if no decision is active
        # (For this demo, we assume a fluctuating base load around 1000kW)
        base_load = 1000.0
        # Simple random fluctuation
        current_load = base_load + random.uniform(-20, 20)
        
        # 2. Evolve Thermal State
        twin = ThermalTwin(self.therm_cfg, self.therm_state)
        # We step the twin forward by dt_s
        twin.step(P_total_kw=current_load, dt_s=dt_s)
        
        # Update latest telemetry cache
        self._latest = self._compute_latest_telemetry_point(current_load)
        
        # self.therm_state is updated in-place by twin.step
        
        # Option: Persist snapshots periodically? 
        # For now, we only persist explicit decisions to keep DB clean.
        
        return self.therm_state

    def _compute_latest_telemetry_point(self, current_load: float) -> Dict[str, Any]:
        """
        Computes a single telemetry point for critical real-time monitoring.
        Mirrors logic in get_timeseries but for 'now'.
        """
        now = datetime.now()
        
        # 1. Frequency (Synthesize simple noise/dip based on random)
        # For 'latest', we can't easily rely on 'i' from the loop easily without state.
        # We'll use a simple random walk or just noise.
        base_freq = 60.0
        # Occasional random dip logic (1% chance per second)
        dip = (random.random() < 0.01)
        freq = (base_freq - 0.15 + random.uniform(-0.02, 0.02)) if dip else (base_freq + random.uniform(-0.02, 0.02))
        stress = 0.85 if dip else 0.10
        rocof = 0.0 # simplified for single point
        
        # 2. Carbon
        carbon_val = 450.0
        if self.carbon:
            try:
                carbon_val = float(self.carbon.get_intensity_g_per_kwh(now))
            except:
                pass
        
        # 3. Safe Shift (GNN)
        safe_shift = 1200.0
        if dip or (self.therm_state.T_c > 48.0):
             safe_shift = 800.0
             
        if self.gnn and self.gnn.is_ready():
            try:
                # Lightweight GNN inference for "latest"
                x_node = torch.zeros(33, 3)
                x_node[:, 0] = torch.rand(33) * 0.2
                x_node[:, 1] = x_node[:, 0] * 0.3
                dc_mw = current_load / 1000.0
                x_node[17, 0] = float(dc_mw)
                safe_shift = self.gnn.predict_safe_shift_kw(x_node)
            except:
                pass

        return {
            "ts": now.isoformat(),
            "frequency_hz": float(freq),
            "rocof_hz_s": float(rocof),
            "stress_score": float(stress),
            "total_load_kw": float(current_load),
            "safe_shift_kw": float(safe_shift),
            "carbon_g_per_kwh": float(carbon_val),
            "rack_temp_c": float(self.therm_state.T_c),
            "cooling_kw": float(self.therm_state.P_cool_kw),
        }
    def get_kpi_summary(self, window_s: int = 900) -> Dict[str, Any]:
        events = list(self.trace)
        return compute_trace_kpis(events, window_s=window_s)
