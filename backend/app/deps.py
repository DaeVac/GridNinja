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
from app.config import env_flag
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
    demo_mode = env_flag("DEMO_MODE", False)
    offline_mode = env_flag("OFFLINE_MODE", False) or env_flag("DEMO_OFFLINE", False)
    gnn_enabled = env_flag("GNN_ENABLED", not (demo_mode or offline_mode))
    carbon_enabled = env_flag("CARBON_ENABLED", True)

    carbon = CarbonService() if CarbonService is not None and carbon_enabled else None
    gnn = GNNHeadroomService() if GNNHeadroomService is not None and gnn_enabled else None
    return DigitalTwinService(gnn=gnn, carbon=carbon)
