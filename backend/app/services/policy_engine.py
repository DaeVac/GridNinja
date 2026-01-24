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
