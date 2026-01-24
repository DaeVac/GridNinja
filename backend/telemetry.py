# apps/backend/app/schemas/telemetry.py
from pydantic import BaseModel


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
