from __future__ import annotations

from enum import Enum
from typing import Any, Dict, List, Optional
from pydantic import BaseModel, Field


# ============================================================
# 0) ENUMS (Type Safety)
# ============================================================

class ComponentType(str, Enum):
    GRID = "GRID"
    THERMAL = "THERMAL"
    RAMP = "RAMP"
    POLICY = "POLICY"
    GNN = "GNN"

class RuleStatus(str, Enum):
    INFO = "INFO"
    ALLOWED = "ALLOWED"
    BLOCKED = "BLOCKED"

class SeverityLevel(str, Enum):
    LOW = "LOW"
    MEDIUM = "MEDIUM"
    HIGH = "HIGH"


# ============================================================
# 1) CONFIG & STATE MODELS (Physics/Twin)
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


class BatteryDegradationConfig(BaseModel):
    # Arrhenius parameters
    Ea: float = 24500.0    # J/mol
    R_gas: float = 8.314   # J/(mol*K)

    # Scaling factor (hackathon tuning knob)
    k_aging: float = 1e-7

    # Gating
    max_cap_loss_frac_per_decision: float = 5e-6
    max_temp_for_aging_c: float = 55.0


# ============================================================
# 2) TRACE & EXPLAINABILITY
# ============================================================

class DecisionTraceEvent(BaseModel):
    ts: str
    decision_id: Optional[str] = None

    component: ComponentType
    rule_id: str
    status: RuleStatus
    severity: SeverityLevel
    message: str

    # Evidence fields for UI
    value: Optional[float] = None
    threshold: Optional[float] = None
    units: Optional[str] = None

    proposed_deltaP_kw: Optional[float] = None
    approved_deltaP_kw: Optional[float] = None
    rack_temp_c: Optional[float] = None


class KpiSummary(BaseModel):
    window_s: int
    unsafe_actions_prevented_total: int
    blocked_decisions_unique: int
    
    # New metrics
    blocked_rate_pct: float = 0.0
    top_blocked_rules: List[str] = Field(default_factory=list)

    unsafe_prevented_by_component: Dict[str, int]
    unsafe_prevented_by_rule: Dict[str, int]


# ============================================================
# 3) RAMP PLANNING & DECISIONS
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
    
    # Explainability details
    primary_constraint: Optional[ComponentType] = None
    constraint_value: Optional[float] = None
    constraint_threshold: Optional[float] = None
    
    steps: List[RampPlanStep] = Field(default_factory=list)


# ============================================================
# 4) API RESPONSE SCHEMAS
# ============================================================

class TelemetryTimeseriesPoint(BaseModel):
    ts: str

    frequency_hz: float
    rocof_hz_s: float
    stress_score: float

    total_load_kw: float
    safe_shift_kw: float

    carbon_g_per_kwh: float

    rack_temp_c: float
    cooling_kw: float


class DecisionResponse(BaseModel):
    ts: str
    decision_id: str

    requested_deltaP_kw: float
    approved_deltaP_kw: float
    blocked: bool
    reason: str

    plan: Dict[str, Any]
    trace: List[Dict[str, Any]]

    prediction_debug: Optional[Dict[str, float]] = None


class TraceLatestResponse(BaseModel):
    ts: str
    events: List[Dict[str, Any]]


class HealthResponse(BaseModel):
    status: str
    ts: str
