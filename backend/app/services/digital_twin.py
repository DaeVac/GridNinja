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

import asyncio
import math
import random
import uuid
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional, Set
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
from app.config import env_flag, env_int
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

    def is_final_phase(e: Dict[str, Any]) -> bool:
        phase = str(e.get("phase") or "final")
        return phase != "candidate"

    recent_final = [e for e in recent if is_final_phase(e)]
    final_decisions = [e for e in recent_final if e.get("rule_id") == "APPROVED_DELTA_SELECTED"]
    decision_ids = {e.get("decision_id") for e in final_decisions if e.get("decision_id")}
    total_recent = len(decision_ids)

    blocked_decisions = {
        e.get("decision_id")
        for e in final_decisions
        if e.get("decision_id") and e.get("status") == RuleStatus.BLOCKED.value
    }

    blocked_events = [e for e in recent_final if e.get("status") == RuleStatus.BLOCKED.value]

    by_component: Dict[str, int] = {}
    by_rule: Dict[str, int] = {}

    for e in blocked_events:
        c = str(e.get("component", "UNKNOWN"))
        r = str(e.get("rule_id", "UNKNOWN"))
        by_component[c] = by_component.get(c, 0) + 1
        by_rule[r] = by_rule.get(r, 0) + 1

    unsafe_actions_prevented_total = 0
    for e in final_decisions:
        status = e.get("status")
        proposed = e.get("proposed_deltaP_kw")
        approved = e.get("approved_deltaP_kw")
        clipped = False
        if proposed is not None and approved is not None:
            try:
                clipped = abs(float(approved)) + 1e-9 < abs(float(proposed))
            except Exception:
                clipped = False
        if status == RuleStatus.BLOCKED.value or clipped:
            unsafe_actions_prevented_total += 1

    blocked_rate_pct = (len(blocked_decisions) / total_recent * 100.0) if total_recent > 0 else 0.0

    # Top blocked rules
    top_rules = [r for r, _ in Counter(by_rule).most_common(3)]
    
    # Financial & Environmental Calcs (Simulated Estimate)
    # We iterate over final decisions to sum up approved kW vs requested
    total_kwh_shifted = 0.0
    total_blocked_requests = len(blocked_decisions)
    
    # Simple proxy: sum up 'approved_deltaP_kw' from "APPROVED_DELTA_SELECTED" events
    for e in final_decisions:
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
        "unsafe_actions_prevented_total": int(unsafe_actions_prevented_total),
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


@dataclass
class DemoScenarioState:
    scenario_id: str
    start_ts: datetime
    speed: float
    duration_s: int
    seed: int
    emitted: Set[str] = field(default_factory=set)


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
        # Start in a realistic steady-state range for demos.
        self.therm_state = ThermalTwinState(T_c=27.0, P_cool_kw=250.0)
        
        # Trace Buffer
        self.trace = deque(maxlen=600)

        # Optional services
        self.gnn = gnn
        self.carbon = carbon

        # Demo flags (deterministic/offline stability)
        self.demo_mode = env_flag("DEMO_MODE", False)
        self.deterministic = env_flag("DEMO_DETERMINISTIC", self.demo_mode)
        self._demo_seed = env_int("DEMO_SEED", 7)
        self._rng = random.Random(self._demo_seed) if self.deterministic else random.Random()
        
        # Latest telemetry point (for WebSockets)
        self._latest: Optional[Dict[str, Any]] = None
        self._last_thermal_debug: Dict[str, float] = {}

        # Demo scenario runner
        self._demo_scenario: Optional[DemoScenarioState] = None
        self._demo_event_log: deque = deque(maxlen=20)
        self._demo_price_multiplier: float = 1.0
        self._demo_last_effects: Dict[str, float] = {}

    # -----------------------------
    # Demo Scenario Runner
    # -----------------------------
    def list_demo_scenarios(self) -> List[Dict[str, Any]]:
        return [
            {
                "id": "heat_wave",
                "label": "Heat Wave + Cooling Degradation",
                "duration_s": 600,
                "description": "Ambient temp rises, cooling efficiency drops, thermal margin tightens.",
            },
            {
                "id": "price_spike",
                "label": "Price Spike + Demand Surge",
                "duration_s": 300,
                "description": "Energy prices spike briefly; demand surges and value of shifting jumps.",
            },
        ]

    def start_demo_scenario(
        self, scenario_id: str, speed: float = 1.0, seed: Optional[int] = None
    ) -> Dict[str, Any]:
        scenarios = {s["id"]: s for s in self.list_demo_scenarios()}
        if scenario_id not in scenarios:
            raise ValueError("unknown scenario")
        speed = max(0.1, min(20.0, float(speed)))
        seed_val = int(seed) if seed is not None else self._demo_seed
        self._demo_scenario = DemoScenarioState(
            scenario_id=scenario_id,
            start_ts=datetime.now(),
            speed=speed,
            duration_s=int(scenarios[scenario_id]["duration_s"]),
            seed=seed_val,
        )
        self._demo_event_log.clear()
        self._demo_price_multiplier = 1.0
        self._demo_last_effects = {}
        return {
            "scenario_id": scenario_id,
            "speed": speed,
            "seed": seed_val,
            "duration_s": scenarios[scenario_id]["duration_s"],
        }

    def stop_demo_scenario(self) -> None:
        self._demo_scenario = None
        self._demo_event_log.clear()
        self._demo_price_multiplier = 1.0
        self._demo_last_effects = {}

    def get_demo_status(self) -> Dict[str, Any]:
        if not self._demo_scenario:
            return {
                "active": False,
                "scenario_id": None,
                "t_sim_s": 0.0,
                "speed": 1.0,
                "event_log": list(self._demo_event_log),
            }
        now = datetime.now()
        t_sim = (now - self._demo_scenario.start_ts).total_seconds() * self._demo_scenario.speed
        return {
            "active": True,
            "scenario_id": self._demo_scenario.scenario_id,
            "t_sim_s": round(t_sim, 1),
            "speed": self._demo_scenario.speed,
            "event_log": list(self._demo_event_log),
        }

    def _demo_emit_event(self, key: str, message: str, t_sim: float) -> None:
        if not self._demo_scenario:
            return
        if key in self._demo_scenario.emitted:
            return
        self._demo_scenario.emitted.add(key)
        self._demo_event_log.append(
            {
                "ts": datetime.now().isoformat(),
                "scenario_id": self._demo_scenario.scenario_id,
                "t_sim_s": round(t_sim, 1),
                "message": message,
            }
        )

    def _demo_effects(self) -> Dict[str, float]:
        if not self._demo_scenario:
            self._demo_price_multiplier = 1.0
            return {}

        now = datetime.now()
        t_sim = (now - self._demo_scenario.start_ts).total_seconds() * self._demo_scenario.speed
        duration = float(self._demo_scenario.duration_s)
        if t_sim >= duration:
            self.stop_demo_scenario()
            return {}

        sid = self._demo_scenario.scenario_id
        effects: Dict[str, float] = {
            "t_sim_s": float(t_sim),
            "load_delta_kw": 0.0,
            "ambient_delta_c": 0.0,
            "cooling_cop_scale": 1.0,
            "price_multiplier": 1.0,
            "freq_bias_hz": 0.0,
        }

        if sid == "heat_wave":
            # Ramp up 0-120s, peak 120-360s, cool down 360-600s
            if t_sim < 120:
                ramp = t_sim / 120.0
            elif t_sim < 360:
                ramp = 1.0
            else:
                ramp = max(0.0, 1.0 - (t_sim - 360.0) / 240.0)

            effects["load_delta_kw"] = 800.0 * ramp
            effects["ambient_delta_c"] = 10.0 * ramp
            effects["cooling_cop_scale"] = 1.0 - 0.3 * ramp
            effects["freq_bias_hz"] = -0.03 * ramp

            if t_sim >= 1.0:
                self._demo_emit_event("heat_wave_start", "Heat wave begins. Ambient temp rising.", t_sim)
            if t_sim >= 140.0:
                self._demo_emit_event("heat_wave_peak", "Peak heat. Cooling efficiency degraded.", t_sim)
            if t_sim >= 400.0:
                self._demo_emit_event("heat_wave_recover", "Heat wave easing. Thermal margin recovering.", t_sim)

        elif sid == "price_spike":
            # Spike 60-180s, cool down 180-240s
            if t_sim < 60:
                mult = 1.0
            elif t_sim < 180:
                mult = 6.0
            elif t_sim < 240:
                mult = 3.0
            else:
                mult = 1.0

            effects["price_multiplier"] = mult
            effects["load_delta_kw"] = 500.0 if 60 <= t_sim <= 180 else 200.0
            effects["freq_bias_hz"] = -0.015 if 60 <= t_sim <= 180 else 0.0

            if t_sim >= 60.0:
                self._demo_emit_event("price_spike_start", "Price spike detected. Shift value increased.", t_sim)
            if t_sim >= 75.0:
                self._demo_emit_event("price_spike_peak", "Price spike peak window.", t_sim)
            if t_sim >= 200.0:
                self._demo_emit_event("price_spike_end", "Price spike ending. Conditions stabilizing.", t_sim)

        self._demo_price_multiplier = float(effects.get("price_multiplier", 1.0))
        self._demo_last_effects = effects
        return effects

    def get_latest_telemetry(self) -> Optional[Dict[str, Any]]:
        return self._latest

    def set_demo_mode(self, enabled: bool, deterministic: Optional[bool] = None, seed: Optional[int] = None) -> None:
        """
        Toggle demo mode at runtime without recreating the service.
        """
        if deterministic is None:
            deterministic = enabled
        self.demo_mode = bool(enabled)
        self.deterministic = bool(deterministic)
        if seed is not None:
            self._demo_seed = int(seed)
        self._rng = random.Random(self._demo_seed) if self.deterministic else random.Random()
        if enabled:
            self.gnn = None

    # -----------------------------
    # Trace Buffer Access
    # -----------------------------
    def push_trace(self, e: DecisionTraceEvent | Dict[str, Any]) -> None:
        if isinstance(e, DecisionTraceEvent):
            self.trace.append(e.model_dump(mode="json"))
        else:
            try:
                self.trace.append(DecisionTraceEvent(**e).model_dump(mode="json"))
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

        # Seed based on minute resolution, unless demo-deterministic
        if self.deterministic:
            seed_val = int(self._demo_seed + window_s)
            if end_ts and mode == "replay":
                seed_val += int(now.timestamp())
        else:
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
                "it_load_kw": float(it_load),
                "total_load_kw": float(it_load + cooling),
                "safe_shift_kw": float(safe_shift),
                "carbon_g_per_kwh": float(carbon_val),
                "rack_temp_c": float(temp),
                "cooling_kw": float(cooling),
                "q_passive_kw": float(pred.get("q_passive_kw", 0.0)),
                "q_active_kw": float(pred.get("q_active_kw", 0.0)),
                "cooling_target_kw": float(pred.get("cooling_target_kw", 0.0)),
                "cooling_cop": float(pred.get("cooling_cop", 0.0)),
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
                    "phase": "final",
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

        # Heuristic confidence for UI (until model provides it)
        confidence = 0.85
        if plan.blocked:
            confidence = 0.4
        elif abs(float(approved_kw)) + 1e-9 < abs(float(deltaP_request_kw)):
            confidence = 0.65
        if plan.constraint_value is not None and plan.constraint_threshold is not None:
            try:
                margin = float(plan.constraint_threshold) - float(plan.constraint_value)
                if margin < 0:
                    confidence = min(confidence, 0.35)
                elif margin < 0.5:
                    confidence = min(confidence, 0.55)
                elif margin < 1.0:
                    confidence = min(confidence, 0.7)
            except Exception:
                pass

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
                    confidence=float(confidence),
                    
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
    async def tick(self, dt_s: float = 1.0):
        """
        Called by background loop to advance physics.
        Simulates passive thermal drift based on current cooling vs "base" load.
        Made async to prevent GNN inference from blocking the event loop.
        """
        # 1. Simulate a random walk for IT load if no decision is active
        # (For this demo, we assume a fluctuating base load around 1000kW)
        base_load = 1000.0
        # Simple random fluctuation
        current_load = base_load + self._rng.uniform(-20, 20)

        demo_effects = self._demo_effects()
        if demo_effects:
            current_load += float(demo_effects.get("load_delta_kw", 0.0))
        
        # 2. Evolve Thermal State
        cfg = self.therm_cfg
        if demo_effects:
            try:
                cfg = self.therm_cfg.model_copy(deep=True)
            except Exception:
                try:
                    cfg = ThermalTwinConfig(**self.therm_cfg.model_dump())
                except Exception:
                    cfg = ThermalTwinConfig(**self.therm_cfg.dict())
            cfg.T_ambient = float(cfg.T_ambient) + float(demo_effects.get("ambient_delta_c", 0.0))
            cfg.Cooling_COP = float(cfg.Cooling_COP) * float(demo_effects.get("cooling_cop_scale", 1.0))
        twin = ThermalTwin(cfg, self.therm_state)
        # We step the twin forward by dt_s
        pred = twin.step(P_it_kw=current_load, dt_s=dt_s)
        self._last_thermal_debug = {
            "q_passive_kw": float(pred.get("q_passive_kw", 0.0)),
            "q_active_kw": float(pred.get("q_active_kw", 0.0)),
            "cooling_target_kw": float(pred.get("cooling_target_kw", 0.0)),
            "cooling_cop": float(pred.get("cooling_cop", 0.0)),
        }
        
        # Update latest telemetry cache (async to avoid blocking on GNN)
        self._latest = await self._compute_latest_telemetry_point_async(
            current_load,
            demo_effects=demo_effects,
        )
        
        # self.therm_state is updated in-place by twin.step
        
        # Option: Persist snapshots periodically? 
        # For now, we only persist explicit decisions to keep DB clean.
        
        return self.therm_state

    async def _compute_latest_telemetry_point_async(
        self, current_load: float, demo_effects: Optional[Dict[str, float]] = None
    ) -> Dict[str, Any]:
        """
        Computes a single telemetry point for critical real-time monitoring.
        Uses asyncio.to_thread to offload GNN inference and prevent event loop starvation.
        """
        now = datetime.now()
        
        # 1. Frequency (Synthesize simple noise/dip based on random)
        base_freq = 60.0
        # Occasional random dip logic (1% chance per second)
        dip = (self._rng.random() < 0.01)
        freq = (base_freq - 0.15 + self._rng.uniform(-0.02, 0.02)) if dip else (base_freq + self._rng.uniform(-0.02, 0.02))
        if demo_effects:
            freq += float(demo_effects.get("freq_bias_hz", 0.0))
        stress = 0.85 if dip else 0.10
        rocof = 0.0 # simplified for single point
        
        # 2. Carbon
        carbon_val = 450.0
        if self.carbon:
            try:
                carbon_val = float(self.carbon.get_intensity_g_per_kwh(now))
            except:
                pass
        
        # 3. Safe Shift (GNN) - wrapped in to_thread to avoid blocking event loop
        safe_shift = 1200.0
        if dip or (self.therm_state.T_c > 48.0):
             safe_shift = 800.0
             
        if self.gnn and self.gnn.is_ready():
            try:
                # Offload blocking GNN inference to thread pool
                def _gnn_predict():
                    x_node = torch.zeros(33, 3)
                    x_node[:, 0] = torch.rand(33) * 0.2
                    x_node[:, 1] = x_node[:, 0] * 0.3
                    dc_mw = current_load / 1000.0
                    x_node[17, 0] = float(dc_mw)
                    return self.gnn.predict_safe_shift_kw(x_node)
                
                safe_shift = await asyncio.to_thread(_gnn_predict)
            except:
                pass

        price_multiplier = float(demo_effects.get("price_multiplier", 1.0)) if demo_effects else 1.0
        price_usd_per_mwh = 60.0 * price_multiplier
        scenario_id = self._demo_scenario.scenario_id if self._demo_scenario else None
        t_sim = float(demo_effects.get("t_sim_s", 0.0)) if demo_effects else None

        return {
            "ts": now.isoformat(),
            "frequency_hz": float(freq),
            "rocof_hz_s": float(rocof),
            "stress_score": float(stress),
            "it_load_kw": float(current_load),
            "total_load_kw": float(current_load + self.therm_state.P_cool_kw),
            "safe_shift_kw": float(safe_shift),
            "carbon_g_per_kwh": float(carbon_val),
            "rack_temp_c": float(self.therm_state.T_c),
            "cooling_kw": float(self.therm_state.P_cool_kw),
            "q_passive_kw": float(self._last_thermal_debug.get("q_passive_kw", 0.0)),
            "q_active_kw": float(self._last_thermal_debug.get("q_active_kw", 0.0)),
            "cooling_target_kw": float(self._last_thermal_debug.get("cooling_target_kw", 0.0)),
            "cooling_cop": float(self._last_thermal_debug.get("cooling_cop", 0.0)),
            "price_usd_per_mwh": float(price_usd_per_mwh),
            "scenario_id": scenario_id,
            "t_sim_s": t_sim,
        }
    def get_kpi_summary(self, window_s: int = 900) -> Dict[str, Any]:
        events = list(self.trace)
        kpis = compute_trace_kpis(events, window_s=window_s)
        if self._demo_price_multiplier != 1.0:
            kpis["money_saved_usd"] = float(
                round(kpis.get("money_saved_usd", 0.0) * self._demo_price_multiplier, 2)
            )
        return kpis
