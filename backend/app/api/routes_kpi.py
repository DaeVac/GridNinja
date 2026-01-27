from __future__ import annotations

from fastapi import APIRouter, Query
from app.deps import get_twin_service
from app.models.domain import KpiSummary

router = APIRouter()

@router.get("/summary", response_model=KpiSummary)
async def kpi_summary(
    window_s: int = Query(900, ge=60, le=3600, description="KPI aggregation window in seconds"),
) -> KpiSummary:
    try:
        svc = get_twin_service()
        k = svc.get_kpi_summary(window_s=window_s)
        return KpiSummary(**k)
    except Exception:
        # Demo-safe fallback to avoid 500s if trace/state is unavailable
        return KpiSummary(
            window_s=int(window_s),
            unsafe_actions_prevented_total=0,
            blocked_decisions_unique=0,
            blocked_rate_pct=0.0,
            top_blocked_rules=[],
            money_saved_usd=0.0,
            co2_avoided_kg=0.0,
            sla_penalty_usd=0.0,
            jobs_completed_on_time_pct=0.0,
            unsafe_prevented_by_component={},
            unsafe_prevented_by_rule={},
        )
