# apps/backend/app/api/routes_health.py
from __future__ import annotations

from datetime import datetime
from fastapi import APIRouter
from app.schemas.health import HealthResponse

router = APIRouter()

@router.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    return HealthResponse(status="ok", ts=datetime.now().isoformat())
