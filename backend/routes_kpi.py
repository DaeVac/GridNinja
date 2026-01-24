# apps/backend/app/api/routes_kpi.py
from __future__ import annotations

from fastapi import APIRouter, Query
from app.deps import get_twin_service
from app.schemas.kpi import KpiSummary

router = APIRouter()

@router.get("/summary", response_model=KpiSummary)
async def kpi_summary(
    window_s: int = Query(900, ge=60, le=3600, description="KPI aggregation window in seconds"),
) -> KpiSummary:
    svc = get_twin_service()
    k = svc.get_kpi_summary(window_s=window_s)
    return KpiSummary(**k)
