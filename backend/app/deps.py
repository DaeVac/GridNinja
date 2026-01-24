# apps/backend/app/deps.py
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
