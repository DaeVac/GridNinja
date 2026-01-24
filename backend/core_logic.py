# apps/backend/core/core_logic.py
from __future__ import annotations

import math
import random
from collections import deque
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional, Tuple

from pydantic import BaseModel, Field


# ============================================================
# 0) COOLANT PROPERTIES (Water/Glycol)
# ============================================================

def get_coolant_props(T_k: float, glycol_pct: float = 0.30) -> Tuple[float, float]:
    """
    Returns (rho, cp) for a water/glycol mix.
    Hackathon approximation inspired by ASHRAE trends.
    Units:
      rho: kg/m^3
      cp:  J/(kg*K)
    """
    T_c = T_k - 273.15

    # Density decreases with temperature (rough trend)
    rho = 1050.0 - (0.50 * T_c)

    # Specific heat trend (simplified; real blends are more complex)
    cp = 3800.0 + (1.50 * T_c)

    # Clamp for sanity
    rho = max(900.0, min(1100.0, rho))
    cp = max(2500.0, min(4500.0, cp))
    return rho, cp


# ============================================================
# 1) TRACE EVENT SCHEMA (Explainability)
# ============================================================

class DecisionTraceEvent(BaseModel):
    ts: str
    decision_id: Optional[str] = None

    component: str  # "GRID" | "THERMAL" | "RAMP" | "POLICY" | "GNN"
    rule_id: str    # stable identifier
    status: str     # "ALLOWED" | "BLOCKED" | "INFO"
    severity: str   # "LOW" | "MEDIUM" | "HIGH"
    message: str

    # Evidence fields for UI
    value: Optional[float] = None
    threshold: Optional[float] = None
    units: Optional[str] = None

    proposed_deltaP_kw: Optional[float] = None
    approved_deltaP_kw: Optional[float] = None
    rack_temp_c: Optional[float] = None


# ============================================================
# 2) THERMAL TWIN (Physics Engine)
# ============================================================

class ThermalTwinConfig(BaseModel):
    """
    Physical constants for rack + coolant thermal model.
    Units chosen so that:
      - P terms are in kW (= kJ/s)
      - C_mass is in kJ/°C
      - K_transfer is in kW/°C
    """
    # Fallback constant thermal mass (kJ/°C)
    C_mass: float = 150.0

    # Passive heat transfer coefficient (kW/°C)
    K_transfer: float = 2.5

    # Max safe rack temperature (°C)
    T_max: float = 50.0

    # CRAC supply / ambient reference (°C)
    T_ambient: float = 20.0

    # Cooling power ramp limit (kW/s)
    Cooling_Ramp_Max: float = 5.0

    # Cooling efficiency multiplier (0..1)
    Cooling_Efficiency: float = 0.80

    # --- Coolant realism ---
    glycol_pct: float = 0.30
    coolant_volume_m3: float = 0.06
    use_dynamic_coolant_mass: bool = True


class ThermalTwinState(BaseModel):
    T_c: float           # rack temperature (°C)
    P_cool_kw: float     # current cooling power (kW)


class ThermalTwin:
    def __init__(self, cfg: ThermalTwinConfig, state: ThermalTwinState):
        self.cfg = cfg
        self.state = state

    def _dynamic_C_mass_kj_per_c(self) -> float:
        """
        Compute effective thermal mass C(T) = rho(T)*V*cp(T).
        Returns kJ/°C.
        """
        if not self.cfg.use_dynamic_coolant_mass:
            return float(self.cfg.C_mass)

        T_k = self.state.T_c + 273.15
        rho, cp = get_coolant_props(T_k, glycol_pct=self.cfg.glycol_pct)

        # rho [kg/m3] * V [m3] -> kg
        # cp [J/kgK] -> J/K
        # Convert J/K to kJ/°C
        C_kj_per_c = (rho * self.cfg.coolant_volume_m3 * cp) / 1000.0
        return float(max(1e-3, C_kj_per_c))

    def predict(self, P_it_kw: float, dt_s: float) -> Dict[str, float]:
        """
        Euler step of first-order thermal ODE:

          dT/dt = (P_in - P_out) / C(T)

        P_in  = IT load (kW)
        P_out = passive loss K*(T - Tamb) + active cooling (eff * P_cool)

        Also includes cooling actuator lag (ramp rate limit).
        """
        # 1) Cooling response with ramp limit
        target_cooling_kw = float(max(0.0, P_it_kw))  # simple target = match IT load
        delta_cool = target_cooling_kw - self.state.P_cool_kw

        max_change = self.cfg.Cooling_Ramp_Max * float(dt_s)
        delta_cool_clamped = max(-max_change, min(max_change, delta_cool))
        next_cooling_kw = self.state.P_cool_kw + delta_cool_clamped

        # 2) Passive + active dissipation
        q_passive = self.cfg.K_transfer * (self.state.T_c - self.cfg.T_ambient)  # kW
        q_active = next_cooling_kw * self.cfg.Cooling_Efficiency               # kW

        # 3) Net heat flow (kW = kJ/s)
        net_heat_kw = float(P_it_kw) - (float(q_passive) + float(q_active))

        # 4) Integrate temperature
        C_mass = self._dynamic_C_mass_kj_per_c()  # kJ/°C
        delta_T = (net_heat_kw * float(dt_s)) / C_mass
        next_temp_c = self.state.T_c + float(delta_T)

        thermal_ok = next_temp_c < self.cfg.T_max

        return {
            "rack_temp_c_next": float(next_temp_c),
            "cooling_kw_next": float(next_cooling_kw),
            "thermal_ok_next": bool(thermal_ok),
            "thermal_headroom_kw": float(self._calculate_headroom_kw(next_temp_c, next_cooling_kw)),
        }

    def _calculate_headroom_kw(self, next_temp_c: float, next_cooling_kw: float) -> float:
        """
        Rough estimate of additional kW load available before hitting T_max.
        This is a heuristic for UI diagnostics, not strict physics.
        """
        buffer_c = self.cfg.T_max - next_temp_c
        if buffer_c <= 0:
            return 0.0

        # If temperature rises, more passive loss increases ~K*ΔT.
        # Convert buffer to "extra heat removable" ≈ K*buffer + eff*cooling_margin.
        # Here we assume cooling can keep up by ~eff*cooling_kw (bounded).
        headroom = (self.cfg.K_transfer * buffer_c) + (next_cooling_kw * self.cfg.Cooling_Efficiency * 0.1)
        return float(max(0.0, headroom))

    def step(self, P_it_kw: float, dt_s: float) -> Dict[str, float]:
        pred = self.predict(P_it_kw, dt_s)
        # Commit state update
        self.state.T_c = pred["rack_temp_c_next"]
        self.state.P_cool_kw = pred["cooling_kw_next"]
        return pred


# ============================================================
# 3) BATTERY DEGRADATION (Arrhenius Aging)
# ============================================================

class BatteryDegradationConfig(BaseModel):
    # Arrhenius parameters
    Ea: float = 24500.0    # J/mol
    R_gas: float = 8.314   # J/(mol*K)

    # Scaling factor (hackathon tuning knob)
    k_aging: float = 1e-7

    # Gating
    max_cap_loss_frac_per_decision: float = 5e-6
    max_temp_for_aging_c: float = 55.0


def arrhenius_aging_step(
    cfg: BatteryDegradationConfig,
    T_c: float,
    throughput_kw: float,
    dt_s: float,
) -> float:
    """
    Differential update:
      dCapLoss/dt = k * exp(-Ea/(R*T)) * throughput

    cap_loss is a unitless fraction (0.01 = 1% total loss).
    """
    T_c = float(min(T_c, cfg.max_temp_for_aging_c))
    T_k = T_c + 273.15

    # Arrhenius factor: higher temperature => larger factor
    aging_factor = math.exp(-cfg.Ea / (cfg.R_gas * T_k))

    throughput_kw = float(max(0.0, throughput_kw))
    dcap = cfg.k_aging * aging_factor * throughput_kw * float(dt_s)

    return float(max(0.0, dcap))


# ============================================================
# 4) RAMP PLAN STRUCTURES (Backend -> UI)
# ============================================================

class RampPlanStep(BaseModel):
    t_offset_s: int
    proposed_deltaP_kw: float

    rack_temp_c: float
    cooling_kw: float

    thermal_ok: bool
    thermal_headroom_kw: float
    reason: str  # StepReasonCode (string)


class RampPlan(BaseModel):
    requested_deltaP_kw: float
    approved_deltaP_kw: float
    blocked: bool
    reason: str  # DecisionReasonCode (string)
    steps: List[RampPlanStep] = Field(default_factory=list)


# ============================================================
# 5) RAMP PLANNER (constraint gating + decision trace)
# ============================================================

def build_ramp_plan(
    P_site_kw: float,
    grid_headroom_kw: float,
    cfg: ThermalTwinConfig,
    state: ThermalTwinState,
    deltaP_request_kw: float,
    horizon_s: int = 30,
    dt_s: int = 1,
    ramp_rate_kw_per_s: float = 50.0,
    trace_sink: Optional[List[Dict[str, Any]]] = None,
    decision_id: Optional[str] = None,
) -> Tuple[float, RampPlan, Dict[str, float]]:
    """
    Returns: approved_deltaP_kw, RampPlan, prediction_debug

    Pipeline:
      1) clamp by grid headroom
      2) simulate ramp under thermal constraints
      3) enforce battery wear budget (Arrhenius proxy)
      4) binary search for max safe deltaP
    """

    batt_cfg = BatteryDegradationConfig()

    def emit(component: str, rule_id: str, status: str, severity: str, message: str, **kwargs):
        if trace_sink is None:
            return
        trace_sink.append(
            DecisionTraceEvent(
                ts=datetime.now().isoformat(),
                decision_id=decision_id,
                component=component,
                rule_id=rule_id,
                status=status,
                severity=severity,
                message=message,
                **kwargs,
            ).model_dump()
        )

    # -----------------------------
    # 1) Grid clamp
    # -----------------------------
    req = float(max(0.0, deltaP_request_kw))
    headroom = float(max(0.0, grid_headroom_kw))
    deltaP_cap = min(req, headroom)

    emit(
        component="GRID",
        rule_id="GRID_HEADROOM_CLAMP",
        status="INFO",
        severity="LOW",
        message="Requested ΔP compared against grid headroom.",
        value=req,
        threshold=headroom,
        units="kW",
        proposed_deltaP_kw=req,
        approved_deltaP_kw=deltaP_cap,
    )

    if deltaP_cap < req:
        emit(
            component="GRID",
            rule_id="GRID_HEADROOM_REDUCED_ACTION",
            status="BLOCKED",
            severity="MEDIUM",
            message="Unsafe action prevented: requested ΔP reduced to fit grid headroom.",
            proposed_deltaP_kw=req,
            approved_deltaP_kw=deltaP_cap,
            units="kW",
        )

    if deltaP_cap <= 0.0:
        emit(
            component="GRID",
            rule_id="GRID_HEADROOM_ZERO",
            status="BLOCKED",
            severity="HIGH",
            message="Unsafe action prevented: no grid headroom available.",
            proposed_deltaP_kw=req,
            approved_deltaP_kw=0.0,
            units="kW",
        )
        plan = RampPlan(
            requested_deltaP_kw=req,
            approved_deltaP_kw=0.0,
            blocked=True,
            reason="GRID_HEADROOM_ZERO",
            steps=[],
        )
        return 0.0, plan, {"grid_headroom_kw": headroom}

    # -----------------------------
    # 2) Candidate simulation
    # -----------------------------
    steps_n = max(1, int(horizon_s // dt_s))

    def simulate_candidate(desired_kw: float) -> Tuple[bool, List[RampPlanStep], float]:
        """
        Simulates ramping to desired_kw over horizon with:
          - ramp rate constraint
          - thermal gating
          - battery wear budget
        Returns:
          (ok, steps, cap_loss_accum)
        """
        sim_state = ThermalTwinState(T_c=float(state.T_c), P_cool_kw=float(state.P_cool_kw))
        twin = ThermalTwin(cfg=cfg, state=sim_state)

        current_delta = 0.0
        cap_loss_accum = 0.0
        step_rows: List[RampPlanStep] = []

        for i in range(steps_n):
            # Ramp rate limiting
            delta_err = desired_kw - current_delta
            max_step = float(ramp_rate_kw_per_s) * float(dt_s)
            delta_step = max(-max_step, min(max_step, delta_err))
            next_delta = current_delta + delta_step

            if abs(delta_step) >= (max_step - 1e-9) and abs(delta_err) > 1e-6:
                emit(
                    component="RAMP",
                    rule_id="RAMP_RATE_LIMIT",
                    status="INFO",
                    severity="LOW",
                    message="ΔP ramp-rate limited for stability.",
                    value=float(delta_step),
                    threshold=float(max_step),
                    units="kW/step",
                    proposed_deltaP_kw=float(desired_kw),
                    approved_deltaP_kw=float(next_delta),
                )

            # Evaluate thermal at next timestep
            P_total_kw = float(P_site_kw) + float(next_delta)
            pred = twin.predict(P_total_kw, float(dt_s))

            # Battery wear proxy: cycling effort + cooling actuation effort
            throughput_kw = abs(next_delta) + abs(pred["cooling_kw_next"] - twin.state.P_cool_kw)
            dcap = arrhenius_aging_step(
                cfg=batt_cfg,
                T_c=float(pred["rack_temp_c_next"]),
                throughput_kw=float(throughput_kw),
                dt_s=float(dt_s),
            )
            cap_loss_accum += float(dcap)

            emit(
                component="POLICY",
                rule_id="BATTERY_AGING_STEP",
                status="INFO",
                severity="LOW",
                message="Battery aging step computed (Arrhenius proxy).",
                value=float(dcap),
                threshold=float(batt_cfg.max_cap_loss_frac_per_decision),
                units="cap_loss_frac",
                proposed_deltaP_kw=float(next_delta),
                approved_deltaP_kw=float(next_delta),
                rack_temp_c=float(pred["rack_temp_c_next"]),
            )

            # Thermal margin gating (optional but powerful)
            thermal_margin_c = float(cfg.T_max) - float(pred["rack_temp_c_next"])
            if thermal_margin_c < 0.5:
                emit(
                    component="THERMAL",
                    rule_id="THERMAL_MARGIN_TOO_THIN",
                    status="BLOCKED",
                    severity="MEDIUM",
                    message="Thermal margin too thin (<0.5°C). Blocking to avoid instability.",
                    value=float(pred["rack_temp_c_next"]),
                    threshold=float(cfg.T_max - 0.5),
                    units="°C",
                    proposed_deltaP_kw=float(next_delta),
                    approved_deltaP_kw=0.0,
                    rack_temp_c=float(pred["rack_temp_c_next"]),
                )
                step_rows.append(
                    RampPlanStep(
                        t_offset_s=i * int(dt_s),
                        proposed_deltaP_kw=float(next_delta),
                        rack_temp_c=float(pred["rack_temp_c_next"]),
                        cooling_kw=float(pred["cooling_kw_next"]),
                        thermal_ok=False,
                        thermal_headroom_kw=float(pred["thermal_headroom_kw"]),
                        reason="THERMAL_MARGIN_TOO_THIN",
                    )
                )
                return False, step_rows, cap_loss_accum

            if not bool(pred["thermal_ok_next"]):
                emit(
                    component="THERMAL",
                    rule_id="THERMAL_OVER_TEMP",
                    status="BLOCKED",
                    severity="HIGH",
                    message="Unsafe action prevented: thermal limit exceeded.",
                    value=float(pred["rack_temp_c_next"]),
                    threshold=float(cfg.T_max),
                    units="°C",
                    proposed_deltaP_kw=float(next_delta),
                    approved_deltaP_kw=0.0,
                    rack_temp_c=float(pred["rack_temp_c_next"]),
                )
                step_rows.append(
                    RampPlanStep(
                        t_offset_s=i * int(dt_s),
                        proposed_deltaP_kw=float(next_delta),
                        rack_temp_c=float(pred["rack_temp_c_next"]),
                        cooling_kw=float(pred["cooling_kw_next"]),
                        thermal_ok=False,
                        thermal_headroom_kw=float(pred["thermal_headroom_kw"]),
                        reason="THERMAL_OVER_TEMP",
                    )
                )
                return False, step_rows, cap_loss_accum

            # Battery wear gate (per decision budget)
            if cap_loss_accum > float(batt_cfg.max_cap_loss_frac_per_decision):
                emit(
                    component="POLICY",
                    rule_id="BATTERY_WEAR_BLOCKED",
                    status="BLOCKED",
                    severity="MEDIUM",
                    message="Unsafe action prevented: projected battery wear exceeds decision budget.",
                    value=float(cap_loss_accum),
                    threshold=float(batt_cfg.max_cap_loss_frac_per_decision),
                    units="cap_loss_frac",
                    proposed_deltaP_kw=float(desired_kw),
                    approved_deltaP_kw=0.0,
                    rack_temp_c=float(pred["rack_temp_c_next"]),
                )
                step_rows.append(
                    RampPlanStep(
                        t_offset_s=i * int(dt_s),
                        proposed_deltaP_kw=float(next_delta),
                        rack_temp_c=float(pred["rack_temp_c_next"]),
                        cooling_kw=float(pred["cooling_kw_next"]),
                        thermal_ok=False,
                        thermal_headroom_kw=float(pred["thermal_headroom_kw"]),
                        reason="BATTERY_WEAR_BLOCKED",
                    )
                )
                return False, step_rows, cap_loss_accum

            # Record step success
            emit(
                component="THERMAL",
                rule_id="THERMAL_PREDICT_STEP",
                status="ALLOWED",
                severity="LOW",
                message="Thermal step prediction evaluated.",
                value=float(pred["rack_temp_c_next"]),
                threshold=float(cfg.T_max),
                units="°C",
                proposed_deltaP_kw=float(next_delta),
                approved_deltaP_kw=float(next_delta),
                rack_temp_c=float(pred["rack_temp_c_next"]),
            )

            step_rows.append(
                RampPlanStep(
                    t_offset_s=i * int(dt_s),
                    proposed_deltaP_kw=float(next_delta),
                    rack_temp_c=float(pred["rack_temp_c_next"]),
                    cooling_kw=float(pred["cooling_kw_next"]),
                    thermal_ok=True,
                    thermal_headroom_kw=float(pred["thermal_headroom_kw"]),
                    reason="OK",
                )
            )

            # Commit state + delta
            twin.step(P_total_kw, float(dt_s))
            current_delta = float(next_delta)

        return True, step_rows, cap_loss_accum

    # -----------------------------
    # 3) Binary search for max safe ΔP (conservative)
    # -----------------------------
    low = 0.0
    high = float(deltaP_cap)
    best = 0.0
    best_steps: List[RampPlanStep] = []
    best_cap_loss = 0.0

    # 10-12 iters gives smooth + fast results
    for _ in range(12):
        mid = (low + high) / 2.0
        ok, steps, caploss = simulate_candidate(mid)

        if ok:
            best = mid
            best_steps = steps
            best_cap_loss = caploss
            low = mid
        else:
            high = mid

    # -----------------------------
    # 4) Finalize plan
    # -----------------------------
    blocked = best <= 1e-6
    if blocked:
        reason = "THERMAL_BLOCKED"
    else:
        reason = "OK"

    emit(
        component="POLICY",
        rule_id="APPROVED_DELTA_SELECTED",
        status="ALLOWED" if not blocked else "BLOCKED",
        severity="LOW" if not blocked else "HIGH",
        message="Approved ΔP selected via conservative search under constraints.",
        proposed_deltaP_kw=req,
        approved_deltaP_kw=float(best),
    )

    plan = RampPlan(
        requested_deltaP_kw=float(req),
        approved_deltaP_kw=float(best),
        blocked=bool(blocked),
        reason=str(reason),
        steps=best_steps,
    )

    debug = {
        "grid_headroom_kw": float(headroom),
        "grid_cap_kw": float(deltaP_cap),
        "battery_cap_loss_accum": float(best_cap_loss),
        "horizon_s": float(horizon_s),
        "dt_s": float(dt_s),
        "ramp_rate_kw_per_s": float(ramp_rate_kw_per_s),
    }

    return float(best), plan, debug


# ============================================================
# 6) DIGITAL TWIN SERVICE OBJECT (state + telemetry + trace)
# ============================================================

class DataCenterTwin:
    """
    Stores persistent demo state + trace ring buffer.
    Generates plausible telemetry for the dashboard.
    """

    def __init__(self):
        self.therm_cfg = ThermalTwinConfig()
        self.therm_state = ThermalTwinState(T_c=42.0, P_cool_kw=800.0)
        self.twin = ThermalTwin(self.therm_cfg, self.therm_state)

        self.trace = deque(maxlen=600)  # recent DecisionTraceEvent dicts

    # -----------------------------
    # Trace Buffer
    # -----------------------------
    def push_trace(self, e: DecisionTraceEvent | Dict[str, Any]) -> None:
        if isinstance(e, DecisionTraceEvent):
            self.trace.append(e.model_dump())
        else:
            # best-effort validation
            try:
                self.trace.append(DecisionTraceEvent(**e).model_dump())
            except Exception:
                self.trace.append(dict(e))

    def get_trace(self, limit: int = 60) -> List[Dict[str, Any]]:
        limit = max(1, min(200, int(limit)))
        return list(self.trace)[-limit:]

    # -----------------------------
    # Thermal State Access
    # -----------------------------
    def get_current_thermal_state(self) -> ThermalTwinState:
        return self.therm_state

    # -----------------------------
    # Telemetry Generation
    # -----------------------------
    def get_history(self, window_s: int = 900) -> List[Dict[str, Any]]:
        """
        Generates 'live-looking' telemetry. Returns 60 points for charts.
        Fields match frontend schema.
        """
        now = datetime.now()
        window_s = max(60, int(window_s))

        num_points = 60
        step_size = max(1, window_s // num_points)

        # Start from current thermal state but simulate a short history.
        temp = float(self.therm_state.T_c)
        cooling = float(self.therm_state.P_cool_kw)

        out: List[Dict[str, Any]] = []

        prev_freq = 60.0

        for i in range(num_points):
            t = now - timedelta(seconds=(window_s - (i * step_size)))

            # Grid frequency: create a "dip" segment in the middle of window
            base_freq = 60.0
            dip = (25 <= i <= 35)
            noise = random.uniform(-0.02, 0.02)
            freq = (base_freq - 0.15 + noise) if dip else (base_freq + noise)

            rocof = (freq - prev_freq) / float(step_size)
            prev_freq = freq

            stress = 0.85 if dip else 0.10

            # IT load: base + small random drift
            base_load = 1000.0
            it_load = base_load + random.uniform(-15, 15)

            # Carbon intensity (simple wave)
            carbon = 450.0 + (math.sin(i / 9.0) * 50.0)

            # Thermal twin prediction for this historical point
            sim_state = ThermalTwinState(T_c=temp, P_cool_kw=cooling)
            sim_twin = ThermalTwin(self.therm_cfg, sim_state)
            pred = sim_twin.predict(it_load, dt_s=float(step_size))

            temp = pred["rack_temp_c_next"]
            cooling = pred["cooling_kw_next"]

            # safe_shift_kw: placeholder for GNN output (clamped by thermal)
            safe_shift = 1200.0
            if temp > (self.therm_cfg.T_max - 2.0):
                safe_shift = 800.0
            if dip:
                # during frequency stress, clamp further to show "grid-aware safety"
                safe_shift = min(safe_shift, 900.0)

            out.append(
                {
                    "ts": t.isoformat(),
                    "frequency_hz": float(freq),
                    "rocof_hz_s": float(rocof),
                    "stress_score": float(stress),

                    "total_load_kw": float(it_load),
                    "safe_shift_kw": float(safe_shift),

                    "carbon_g_per_kwh": float(carbon),

                    "rack_temp_c": float(temp),
                    "cooling_kw": float(cooling),
                }
            )

        return out


# ============================================================
# 7) KPI COMPUTATION (Trace -> UI)
# ============================================================

def _parse_iso(ts: str) -> Optional[datetime]:
    try:
        return datetime.fromisoformat(ts)
    except Exception:
        return None


def compute_trace_kpis(events: List[Dict[str, Any]], window_s: int = 900) -> Dict[str, Any]:
    """
    Derives KPIs from trace events in the last window_s seconds:
      - unsafe_actions_prevented_total (BLOCKED events)
      - blocked_decisions_unique (unique decision_id among blocked events)
      - breakdown by component and rule_id
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
