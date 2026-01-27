"""
physics_engine.py

Purpose:
  Contains the core physical formulas and first-principles models for the data center.
  It calculates thermal dynamics, cooling power, and battery degradation.

Governing Equations:
  - **Newton's Law of Cooling**: `dT/dt = -K * (T - T_ambient) + Heat_Input / C_mass`
  - **Power-to-Heat**: Assumes 100% of server power (`P_it`) converts to heat.
  - **Cooling Power**: Modeled as `P_cool = f(P_remove, Efficiency)`.

Units & Conventions:
  - **Power**: Kilowatts (kW)
  - **Temperature**: Degrees Celsius (°C)
  - **Time**: Seconds (s)
  - **Mass/Capacity**: kJ/°C (thermal mass)

Simplified vs. Realistic:
  - **Simplified**: Lumped capacitance model (one "T_rack" for the whole row).
  - **Realistic**: Includes coolant specific heat, flow rate dynamics, and efficiency curves.

Safety Thresholds:
  - `T_max`: Absolute maximum safe temperature (default 50°C).
  - `Cooling_Ramp_Max`: Mechanical constraint on chiller spool-up.
"""
from __future__ import annotations

from typing import Dict, Tuple

from app.models.domain import ThermalTwinConfig, ThermalTwinState


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
# 2) THERMAL TWIN (Physics Engine)
# ============================================================

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
        P_out = passive loss K*(T - Tamb) + active cooling (COP * P_cool)

        Also includes cooling actuator lag (ramp rate limit).
        """
        # 1) Passive heat rejection (kW)
        q_passive = self.cfg.K_transfer * (self.state.T_c - self.cfg.T_ambient)

        # 2) Base heat that still must be removed mechanically (kW)
        heat_to_remove_kw = max(0.0, float(P_it_kw) - float(q_passive))

        # 3) Temperature-aware target: only "pay" for cooling when you need it
        temp_err = float(self.state.T_c) - float(self.cfg.T_setpoint)
        if temp_err <= -float(self.cfg.T_deadband):
            target_heat_removed_kw = heat_to_remove_kw * 0.10  # coast
        elif abs(temp_err) <= float(self.cfg.T_deadband):
            target_heat_removed_kw = heat_to_remove_kw * 0.30  # maintain
        else:
            target_heat_removed_kw = heat_to_remove_kw + (float(self.cfg.Kp_temp_kw_per_c) * temp_err)

        # 4) Convert heat removal target -> electrical cooling using COP
        cop = max(1e-6, float(self.cfg.Cooling_COP))
        target_cooling_kw = target_heat_removed_kw / cop

        # 5) Clamp and ramp-limit the actuator
        target_cooling_kw = max(float(self.cfg.Cooling_Min_KW), min(float(self.cfg.Cooling_Max_KW), target_cooling_kw))
        delta_cool = target_cooling_kw - self.state.P_cool_kw

        max_change = self.cfg.Cooling_Ramp_Max * float(dt_s)
        delta_cool_clamped = max(-max_change, min(max_change, delta_cool))
        next_cooling_kw = self.state.P_cool_kw + delta_cool_clamped
        next_cooling_kw = max(float(self.cfg.Cooling_Min_KW), min(float(self.cfg.Cooling_Max_KW), next_cooling_kw))

        # 6) Active heat removal (kW)
        q_active = next_cooling_kw * cop

        # 3) Net heat flow (kW = kJ/s)
        net_heat_kw = float(P_it_kw) - (float(q_passive) + float(q_active))

        # 4) Integrate temperature
        C_mass = self._dynamic_C_mass_kj_per_c()  # kJ/°C
        delta_T = (net_heat_kw * float(dt_s)) / C_mass
        next_temp_c = self.state.T_c + float(delta_T)
        # Floor only after integration (avoid pinning/teleporting each step).
        next_temp_c = max(float(self.cfg.T_min), float(next_temp_c))

        thermal_ok = next_temp_c < self.cfg.T_max

        return {
            "rack_temp_c_next": float(next_temp_c),
            "cooling_kw_next": float(next_cooling_kw),
            "thermal_ok_next": bool(thermal_ok),
            "thermal_headroom_kw": float(self._calculate_headroom_kw(next_temp_c, next_cooling_kw)),
            "q_passive_kw": float(q_passive),
            "q_active_kw": float(q_active),
            "cooling_target_kw": float(target_cooling_kw),
            "cooling_cop": float(cop),
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
        # Convert buffer to "extra heat removable" ≈ K*buffer + COP*cooling_margin.
        # Here we assume cooling can keep up by ~COP*cooling_kw (bounded).
        headroom = (self.cfg.K_transfer * buffer_c) + (next_cooling_kw * self.cfg.Cooling_COP * 0.1)
        return float(max(0.0, headroom))

    def step(self, P_it_kw: float, dt_s: float) -> Dict[str, float]:
        pred = self.predict(P_it_kw, dt_s)
        # Commit state update
        self.state.T_c = pred["rack_temp_c_next"]
        self.state.P_cool_kw = pred["cooling_kw_next"]
        return pred
