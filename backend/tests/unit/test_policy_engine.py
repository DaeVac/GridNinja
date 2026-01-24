import pytest
from app.services.policy_engine import build_ramp_plan
from app.models.domain import ThermalTwinConfig, ThermalTwinState, RampPlan
from app.models.domain import RuleStatus

# ============================================================
# TABLE-DRIVEN TESTS FOR POLICY ENGINE (DECISION LOGIC)
# ============================================================

@pytest.fixture
def base_state():
    return ThermalTwinState(T_c=40.0, P_cool_kw=100.0)

@pytest.fixture
def base_cfg():
    return ThermalTwinConfig(
        T_max=50.0,
        Cooling_Ramp_Max=50.0
    )

@pytest.mark.parametrize("case", [
    {
        "id": "grid_constraints_strict",
        "req": 500.0, "headroom": 100.0,
        "expect_approved": 100.0,
        "expect_blocked": False,
        "desc": "Request exceeds grid headroom -> Clamp to headroom"
    },
    {
        "id": "grid_zero_headroom",
        "req": 500.0, "headroom": 0.0,
        "expect_approved": 0.0,
        "expect_blocked": True,
        "reason_contains": "GRID_HEADROOM_ZERO",
        "desc": "Zero headroom -> Block immediately"
    },
    {
        "id": "thermal_safe_small",
        "req": 10.0, "headroom": 1000.0,
        "expect_approved": 10.0,
        "expect_blocked": False,
        "desc": "Small request, plenty of headroom -> Approved full"
    },
])
def test_build_ramp_plan_grid(case, base_cfg, base_state):
    """Test grid-level clamping logic."""
    approved, plan, _ = build_ramp_plan(
        P_site_kw=1000.0,
        grid_headroom_kw=case["headroom"],
        cfg=base_cfg,
        state=base_state,
        deltaP_request_kw=case["req"],
        horizon_s=10
    )
    
    assert approved == pytest.approx(case["expect_approved"], abs=1e-3)
    assert plan.blocked == case["expect_blocked"]
    
    if "reason_contains" in case:
        assert case["reason_contains"] in plan.reason

def test_thermal_blocking(base_cfg, base_state):
    """Test that policy blocks if thermal limits would be violated."""
    # Force state near limit
    hot_state = ThermalTwinState(T_c=49.0, P_cool_kw=100.0) # 1 degree from limit
    
    # Request huge load
    approved, plan, debug = build_ramp_plan(
        P_site_kw=1000.0,
        grid_headroom_kw=5000.0,
        cfg=base_cfg,
        state=hot_state,
        deltaP_request_kw=2000.0, # Massive jump
        horizon_s=30
    )
    
    # Logic should find 2000kW unsafe and reduce it drastically or block it
    # Since we are so close to temp limit, it likely clamps to near zero
    assert approved < 500.0 
    # If it finds *some* safe room (binary search), it won't be blocked, just reduced.
    # If it blocks entirely:
    if plan.blocked:
        assert plan.reason == "THERMAL_BLOCKED"

def test_trace_generation(base_cfg, base_state):
    """Ensure trace events are emitted with correct Enums."""
    trace = []
    build_ramp_plan(
        P_site_kw=1000.0,
        grid_headroom_kw=100.0, # limit
        cfg=base_cfg,
        state=base_state,
        deltaP_request_kw=200.0, # > limit
        trace_sink=trace,
        decision_id="test-id"
    )
    
    # Should have a grid clamp event
    clamp_events = [e for e in trace if e["rule_id"] == "GRID_HEADROOM_CLAMP"]
    assert len(clamp_events) > 0
    assert clamp_events[0]["status"] == RuleStatus.INFO.value
    assert clamp_events[0]["decision_id"] == "test-id"
