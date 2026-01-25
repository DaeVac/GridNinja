# apps/backend/app/deps.py
"""
deps.py

Purpose:
  Dependency Injection (DI) container for the application.
  Manages singleton instances of core services to ensure state persistence across requests.

Services Managed:
  - `DigitalTwinService` (The Physics Engine State)
  - `CarbonService` (Environmental Data)
  - `ComparisonService` (if active)

Pattern:
  - Uses `lru_cache` to enforce Singleton pattern for `get_twin_service()`.
  - Allowing easy mocking in tests by overriding `app.dependency_overrides`.
"""
from __future__ import annotations

from functools import lru_cache
from app.services.digital_twin import DigitalTwinService

# Optional services (safe if missing)
try:
    from app.services.carbon_service import CarbonService
except Exception:
    CarbonService = None  # type: ignore

try:
    from app.services.gnn_service import GNNHeadroomService
except Exception:
    GNNHeadroomService = None  # type: ignore


@lru_cache(maxsize=1)
def get_twin_service() -> DigitalTwinService:
    carbon = CarbonService() if CarbonService is not None else None
    gnn = GNNHeadroomService() if GNNHeadroomService is not None else None
    return DigitalTwinService(gnn=gnn, carbon=carbon)
