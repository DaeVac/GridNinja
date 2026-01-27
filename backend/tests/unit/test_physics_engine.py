import pytest
from app.services.physics_engine import ThermalTwin
from app.models.domain import ThermalTwinConfig, ThermalTwinState

# ============================================================
# TABLE-DRIVEN TESTS FOR PHYSICS ENGINE
# ============================================================

def test_predict_structure():
    """Verify return shape matches expectation."""
    cfg = ThermalTwinConfig()
    state = ThermalTwinState(T_c=30.0, P_cool_kw=100.0)
    twin = ThermalTwin(cfg, state)
    
    res = twin.predict(P_it_kw=150.0, dt_s=1.0)
    assert "rack_temp_c_next" in res
    assert "cooling_kw_next" in res
    assert "thermal_ok_next" in res
    assert "thermal_headroom_kw" in res

@pytest.mark.parametrize("scenario", [
    {
        "id": "steady_state",
        "T_init": 30.0, "P_cool_init": 20.0, "P_load": 100.0, "dt": 1.0,
        "desc": "Cooling target matches heat removal -> Temp should barely change"
    },
    {
        "id": "high_load_heat_up",
        "T_init": 30.0, "P_cool_init": 0.0, "P_load": 500.0, "dt": 10.0,
        "desc": "Load >> Cooling -> Temp should rise significantly"
    },
    {
        "id": "cooling_ramp_limited",
        "T_init": 40.0, "P_cool_init": 0.0, "P_load": 500.0, "dt": 1.0,
        "desc": "Cooling needs to jump 0->500 but limited by ramp rate"
    },
])
def test_thermal_scenarios(scenario):
    cfg = ThermalTwinConfig(
        Cooling_Ramp_Max=5.0,  # 5kW/s max ramp
        Cooling_COP=4.0,
        Cooling_Min_KW=0.0,
        Cooling_Max_KW=5000.0,
        T_setpoint=0.0,
        T_deadband=0.1,
        Kp_temp_kw_per_c=0.0,
    )
    state = ThermalTwinState(
        T_c=scenario["T_init"], 
        P_cool_kw=scenario["P_cool_init"]
    )
    twin = ThermalTwin(cfg, state)
    
    pred = twin.predict(P_it_kw=scenario["P_load"], dt_s=scenario["dt"])
    
    # Assertions based on scenario logic
    if scenario["id"] == "high_load_heat_up":
        assert pred["rack_temp_c_next"] > state.T_c
        
    if scenario["id"] == "cooling_ramp_limited":
        # Max ramp is 5kW/s * 1s = 5kW increase
        # Initial was 0, so next should be <= 5.0
        assert pred["cooling_kw_next"] <= (state.P_cool_kw + 5.0 + 1e-6)
        
    if scenario["id"] == "steady_state":
        # Passive cooling/heating might cause small drift, but shouldn't explode
        assert abs(pred["rack_temp_c_next"] - state.T_c) < 1.0

def test_thermal_runaway():
    """Ensure it flags thermal failure correctly."""
    cfg = ThermalTwinConfig(
        T_max=50.0,
        Cooling_COP=3.0,
        Cooling_Min_KW=0.0,
        Cooling_Max_KW=200.0,
        T_setpoint=0.0,
        T_deadband=0.1,
        Kp_temp_kw_per_c=0.0,
    )
    state = ThermalTwinState(T_c=49.0, P_cool_kw=100.0)
    twin = ThermalTwin(cfg, state)
    
    # Huge load, long time -> should breach T_max
    pred = twin.predict(P_it_kw=5000.0, dt_s=10.0)
    
    assert pred["rack_temp_c_next"] > 50.0
    assert pred["thermal_ok_next"] is False
