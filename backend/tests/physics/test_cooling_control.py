import math

import pytest

from app.models.domain import ThermalTwinConfig, ThermalTwinState
from app.services.physics_engine import ThermalTwin
from app.services.policy_engine import build_ramp_plan


def make_cfg(**overrides: float) -> ThermalTwinConfig:
    cfg = ThermalTwinConfig()
    for key, value in overrides.items():
        setattr(cfg, key, value)
    return cfg


def run_steps(twin: ThermalTwin, p_it_kw: float, steps: int, dt_s: float) -> None:
    for _ in range(steps):
        twin.step(P_it_kw=p_it_kw, dt_s=dt_s)


def test_invariants_and_ramp_rate_respected():
    cfg = make_cfg(
        Cooling_Ramp_Max=100.0,
        Cooling_COP=4.0,
        Cooling_Min_KW=0.0,
        Cooling_Max_KW=5000.0,
        T_setpoint=30.0,
        T_deadband=0.5,
        Kp_temp_kw_per_c=80.0,
    )
    twin = ThermalTwin(cfg=cfg, state=ThermalTwinState(T_c=30.0, P_cool_kw=0.0))
    dt = 1.0

    prev_cool = twin.state.P_cool_kw
    for _ in range(50):
        twin.step(P_it_kw=1000.0, dt_s=dt)
        assert twin.state.P_cool_kw >= 0.0
        assert math.isfinite(twin.state.P_cool_kw)
        assert math.isfinite(twin.state.T_c)
        assert abs(twin.state.P_cool_kw - prev_cool) <= cfg.Cooling_Ramp_Max * dt + 1e-6
        prev_cool = twin.state.P_cool_kw


def test_cooling_increase_increases_heat_removed():
    cfg = make_cfg(
        Cooling_Ramp_Max=1000.0,
        Cooling_COP=4.0,
        Cooling_Min_KW=0.0,
        Cooling_Max_KW=5000.0,
        T_setpoint=30.0,
        T_deadband=0.5,
        Kp_temp_kw_per_c=80.0,
    )
    twin = ThermalTwin(cfg=cfg, state=ThermalTwinState(T_c=36.0, P_cool_kw=0.0))

    twin.step(P_it_kw=500.0, dt_s=1.0)
    cool_1 = twin.state.P_cool_kw
    q_active_1 = cool_1 * cfg.Cooling_COP

    twin.step(P_it_kw=1200.0, dt_s=1.0)
    cool_2 = twin.state.P_cool_kw
    q_active_2 = cool_2 * cfg.Cooling_COP

    assert cool_2 >= cool_1
    assert q_active_2 >= q_active_1


def test_cooling_less_than_it_when_cop_gt_1():
    cfg = make_cfg(
        T_ambient=25.0,
        T_setpoint=30.0,
        Cooling_COP=4.0,
        Cooling_Ramp_Max=300.0,
        Cooling_Min_KW=0.0,
        Cooling_Max_KW=5000.0,
        Kp_temp_kw_per_c=80.0,
    )
    twin = ThermalTwin(cfg=cfg, state=ThermalTwinState(T_c=30.0, P_cool_kw=0.0))

    run_steps(twin, p_it_kw=1000.0, steps=300, dt_s=1.0)

    assert math.isfinite(twin.state.T_c)
    assert math.isfinite(twin.state.P_cool_kw)
    assert twin.state.P_cool_kw > 0.0
    assert twin.state.P_cool_kw < 1000.0

    pue = (1000.0 + twin.state.P_cool_kw) / 1000.0
    assert 1.05 <= pue <= 1.6


def test_temperature_converges_near_setpoint():
    cfg = make_cfg(
        T_ambient=25.0,
        T_setpoint=30.0,
        T_deadband=0.5,
        Cooling_COP=4.0,
        Cooling_Ramp_Max=300.0,
        Cooling_Min_KW=0.0,
        Cooling_Max_KW=5000.0,
        Kp_temp_kw_per_c=80.0,
    )
    twin = ThermalTwin(cfg=cfg, state=ThermalTwinState(T_c=33.0, P_cool_kw=0.0))

    run_steps(twin, p_it_kw=800.0, steps=400, dt_s=1.0)

    assert abs(twin.state.T_c - cfg.T_setpoint) < 5.0


def test_disturbance_step_load_stabilizes():
    cfg = make_cfg(
        T_ambient=25.0,
        T_setpoint=30.0,
        T_deadband=0.5,
        Cooling_COP=4.0,
        Cooling_Ramp_Max=200.0,
        Cooling_Min_KW=0.0,
        Cooling_Max_KW=5000.0,
        Kp_temp_kw_per_c=80.0,
        T_max=55.0,
    )
    twin = ThermalTwin(cfg=cfg, state=ThermalTwinState(T_c=30.0, P_cool_kw=0.0))

    run_steps(twin, p_it_kw=500.0, steps=200, dt_s=1.0)
    temp_before = twin.state.T_c
    cool_before = twin.state.P_cool_kw

    twin.step(P_it_kw=1000.0, dt_s=1.0)
    temp_after = twin.state.T_c
    assert temp_after >= temp_before - 0.1

    run_steps(twin, p_it_kw=1000.0, steps=150, dt_s=1.0)
    assert twin.state.P_cool_kw > cool_before
    assert twin.state.T_c < cfg.T_max
    assert abs(twin.state.T_c - cfg.T_setpoint) < 8.0


def test_ambient_step_increases_cooling_and_pue():
    cfg = make_cfg(
        T_ambient=20.0,
        T_setpoint=30.0,
        T_deadband=0.5,
        Cooling_COP=4.0,
        Cooling_Ramp_Max=300.0,
        Cooling_Min_KW=0.0,
        Cooling_Max_KW=5000.0,
        Kp_temp_kw_per_c=80.0,
    )
    twin = ThermalTwin(cfg=cfg, state=ThermalTwinState(T_c=30.0, P_cool_kw=0.0))

    run_steps(twin, p_it_kw=800.0, steps=300, dt_s=1.0)
    cooling_before = twin.state.P_cool_kw
    pue_before = (800.0 + cooling_before) / 800.0

    cfg.T_ambient = 30.0
    run_steps(twin, p_it_kw=800.0, steps=200, dt_s=1.0)
    cooling_after = twin.state.P_cool_kw
    pue_after = (800.0 + cooling_after) / 800.0

    assert cooling_after >= cooling_before - 1e-6
    assert pue_after >= pue_before - 1e-3


def test_cooling_trends_down_below_setpoint():
    cfg = make_cfg(
        T_ambient=25.0,
        T_setpoint=30.0,
        T_deadband=0.5,
        Cooling_COP=4.0,
        Cooling_Ramp_Max=1000.0,
        Cooling_Min_KW=0.0,
        Cooling_Max_KW=5000.0,
        Kp_temp_kw_per_c=80.0,
    )
    twin = ThermalTwin(cfg=cfg, state=ThermalTwinState(T_c=27.0, P_cool_kw=500.0))

    run_steps(twin, p_it_kw=200.0, steps=5, dt_s=1.0)
    assert twin.state.P_cool_kw < 500.0


def test_thermal_block_clears_when_cooled():
    cfg = make_cfg(
        T_max=50.0,
        Cooling_COP=4.0,
        Cooling_Min_KW=0.0,
        Cooling_Max_KW=5000.0,
        T_setpoint=30.0,
        T_deadband=0.5,
        Kp_temp_kw_per_c=80.0,
    )

    hot_state = ThermalTwinState(T_c=49.5, P_cool_kw=0.0)
    approved_hot, plan_hot, _ = build_ramp_plan(
        P_site_kw=1000.0,
        grid_headroom_kw=5000.0,
        cfg=cfg,
        state=hot_state,
        deltaP_request_kw=-2000.0,
        horizon_s=10,
        dt_s=1,
    )
    assert plan_hot.blocked or abs(approved_hot) < 500.0

    cool_state = ThermalTwinState(T_c=35.0, P_cool_kw=300.0)
    approved_cool, plan_cool, _ = build_ramp_plan(
        P_site_kw=1000.0,
        grid_headroom_kw=5000.0,
        cfg=cfg,
        state=cool_state,
        deltaP_request_kw=100.0,
        horizon_s=10,
        dt_s=1,
    )
    assert plan_cool.blocked is False
    assert approved_cool > 0.0
