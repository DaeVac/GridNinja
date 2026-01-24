# apps/backend/app/schemas/kpi.py
from typing import Dict
from pydantic import BaseModel


class KpiSummary(BaseModel):
    window_s: int

    unsafe_actions_prevented_total: int
    blocked_decisions_unique: int

    unsafe_prevented_by_component: Dict[str, int]
    unsafe_prevented_by_rule: Dict[str, int]
