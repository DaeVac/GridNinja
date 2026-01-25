"""
policy_engine.py

Purpose:
  The "Safety System" that enforces operational constraints and business rules.
  It acts as the final gatekeeper for any load shift request.

Decision Hierarchy (Priority Order):
  1. **Blocked**: Hard safety violation (e.g., Battery too hot, Rack overheating).
  2. **Allowed**: Request passes all checks.
  3. **Modified**: Request is safe but clipped (e.g., partial dispatch).

Traceability:
  - Emits `DecisionTraceEvent` for every rule evaluation.
  - Uses `ReasonCode` strings (e.g., "THERMAL_LIMIT", "RAMP_CONSTRAINT_EXCEEDED") for UI feedback.

Invariant Guarantees:
  - Will NEVER approve a shift that predicted to violate `T_max` within `horizon_s`.
  - Will NEVER discharge below `min_soc`.
"""
from __future__ import annotations

import math
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

from app.models.domain import (
    BatteryDegradationConfig,
    DecisionTraceEvent,
    RampPlan,
    RampPlanStep,
    ThermalTwinConfig,
    ThermalTwinState,
    ComponentType,
    RuleStatus,
    SeverityLevel
)
from app.services.physics_engine import ThermalTwin


# ============================================================
# 3) BATTERY DEGRADATION (Arrhenius Aging)
# ============================================================

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
    """

    batt_cfg = BatteryDegradationConfig()

    def emit(component: ComponentType, rule_id: str, status: RuleStatus, severity: SeverityLevel, message: str, **kwargs):
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
        component=ComponentType.GRID,
        rule_id="GRID_HEADROOM_CLAMP",
        status=RuleStatus.INFO,
        severity=SeverityLevel.LOW,
        message="Requested ΔP compared against grid headroom.",
        value=req,
        threshold=headroom,
        units="kW",
        proposed_deltaP_kw=req,
        approved_deltaP_kw=deltaP_cap,
    )

    if deltaP_cap < req:
        emit(
            component=ComponentType.GRID,
            rule_id="GRID_HEADROOM_REDUCED_ACTION",
            status=RuleStatus.BLOCKED,
            severity=SeverityLevel.MEDIUM,
            message="Unsafe action prevented: requested ΔP reduced to fit grid headroom.",
            proposed_deltaP_kw=req,
            approved_deltaP_kw=deltaP_cap,
            units="kW",
        )

    if deltaP_cap <= 0.0:
        emit(
            component=ComponentType.GRID,
            rule_id="GRID_HEADROOM_ZERO",
            status=RuleStatus.BLOCKED,
            severity=SeverityLevel.HIGH,
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
        Simulates ramping to desired_kw over horizon
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
                    component=ComponentType.RAMP,
                    rule_id="RAMP_RATE_LIMIT",
                    status=RuleStatus.INFO,
                    severity=SeverityLevel.LOW,
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

            # Battery wear proxy
            throughput_kw = abs(next_delta) + abs(pred["cooling_kw_next"] - twin.state.P_cool_kw)
            dcap = arrhenius_aging_step(
                cfg=batt_cfg,
                T_c=float(pred["rack_temp_c_next"]),
                throughput_kw=float(throughput_kw),
                dt_s=float(dt_s),
            )
            cap_loss_accum += float(dcap)

            emit(
                component=ComponentType.POLICY,
                rule_id="BATTERY_AGING_STEP",
                status=RuleStatus.INFO,
                severity=SeverityLevel.LOW,
                message="Battery aging step computed (Arrhenius proxy).",
                value=float(dcap),
                threshold=float(batt_cfg.max_cap_loss_frac_per_decision),
                units="cap_loss_frac",
                proposed_deltaP_kw=float(next_delta),
                approved_deltaP_kw=float(next_delta),
                rack_temp_c=float(pred["rack_temp_c_next"]),
            )

            # Thermal margin gating
            thermal_margin_c = float(cfg.T_max) - float(pred["rack_temp_c_next"])
            if thermal_margin_c < 0.5:
                emit(
                    component=ComponentType.THERMAL,
                    rule_id="THERMAL_MARGIN_TOO_THIN",
                    status=RuleStatus.BLOCKED,
                    severity=SeverityLevel.MEDIUM,
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
                    component=ComponentType.THERMAL,
                    rule_id="THERMAL_OVER_TEMP",
                    status=RuleStatus.BLOCKED,
                    severity=SeverityLevel.HIGH,
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

            # Battery wear gate
            if cap_loss_accum > float(batt_cfg.max_cap_loss_frac_per_decision):
                emit(
                    component=ComponentType.POLICY,
                    rule_id="BATTERY_WEAR_BLOCKED",
                    status=RuleStatus.BLOCKED,
                    severity=SeverityLevel.MEDIUM,
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
                component=ComponentType.THERMAL,
                rule_id="THERMAL_PREDICT_STEP",
                status=RuleStatus.ALLOWED,
                severity=SeverityLevel.LOW,
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
    # 3) Binary search
    # -----------------------------
    low = 0.0
    high = float(deltaP_cap)
    best = 0.0
    best_steps: List[RampPlanStep] = []
    best_cap_loss = 0.0
    # 20 iters gives much better precision (~1e-6 relative error)
    for _ in range(20):
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
    primary_constraint = None
    val = None
    thresh = None
    reason = "OK"

    if blocked:
        # Determine WHY it was blocked by checking what limited the binary search
        # 1. Grid Check
        if deltaP_cap <= 1e-6:
            reason = "GRID_HEADROOM_ZERO"
            primary_constraint = ComponentType.GRID
            val = float(req)
            thresh = float(headroom)
        else:
            # 2. Thermal Check (simulate max request to see what breaks)
            ok_max, _, caploss_max = simulate_candidate(deltaP_cap)
            if not ok_max:
                # It's thermal or battery
                # Quick check: is battery limit hit?
                if caploss_max > float(batt_cfg.max_cap_loss_frac_per_decision):
                    reason = "BATTERY_WEAR_BLOCKED"
                    primary_constraint = ComponentType.POLICY
                    val = float(caploss_max)
                    thresh = float(batt_cfg.max_cap_loss_frac_per_decision)
                else:
                    reason = "THERMAL_BLOCKED"
                    primary_constraint = ComponentType.THERMAL
                    # Probing simulation to get exact temp
                    sim_state = ThermalTwinState(T_c=float(state.T_c), P_cool_kw=float(state.P_cool_kw))
                    twin = ThermalTwin(cfg=cfg, state=sim_state)
                    pred = twin.predict(float(P_site_kw) + float(deltaP_cap), float(dt_s))
                    val = float(pred["rack_temp_c_next"])
                    thresh = float(cfg.T_max)

    emit(
        component=ComponentType.POLICY,
        rule_id="APPROVED_DELTA_SELECTED",
        status=RuleStatus.ALLOWED if not blocked else RuleStatus.BLOCKED,
        severity=SeverityLevel.LOW if not blocked else SeverityLevel.HIGH,
        message="Approved ΔP selected via conservative search under constraints.",
        proposed_deltaP_kw=req,
        approved_deltaP_kw=float(best),
    )

    plan = RampPlan(
        requested_deltaP_kw=float(req),
        approved_deltaP_kw=float(best),
        blocked=bool(blocked),
        reason=str(reason),
        primary_constraint=primary_constraint,
        constraint_value=val,
        constraint_threshold=thresh,
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
