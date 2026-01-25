from __future__ import annotations

import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api import (
    routes_decision,
    routes_health,
    routes_kpi,
    routes_telemetry,
    routes_trace,
    routes_grid,
    routes_ws,
)

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
import uuid
import time
import logging

# Configure Logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("api")

class RequestIDMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        request_id = str(uuid.uuid4())
        request.state.request_id = request_id
        response = await call_next(request)
        response.headers["X-Request-ID"] = request_id
        return response

class StructuredLoggerMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        start_time = time.perf_counter()
        
        # Process request
        response = await call_next(request)
        
        process_time_ms = (time.perf_counter() - start_time) * 1000.0
        req_id = getattr(request.state, "request_id", "unknown")
        
        # Log JSON structure
        log_entry = {
            "evt": "api_req",
            "req_id": req_id,
            "method": request.method,
            "path": request.url.path,
            "status": response.status_code,
            "latency_ms": round(process_time_ms, 2)
        }
        logger.info(str(log_entry))
        
        return response

# ============================================================
# FASTAPI APP SETUP
# ============================================================

from app.models.db import create_db_and_tables
from app.deps import get_twin_service
import asyncio
"""
main.py

Purpose:
  Application entrypoint. Bootstraps the FastAPI application, dependency injection container,
  and background tasks.

Lifecycle:
  - **Startup**: Initializes the global `DigitalTwinService` and `PandapowerTopology`.
  - **Shutdown**: Cleanly closes threads and database connections (if any).

Routes:
  - `/decision`: Core decision logic.
  - `/grid`: Topology and ML inference.
  - `/telemetry`: Live streaming (SSE).
  - `/health`: Liveness probes.

Environment:
  - `PORT`: Server port (default 8000).
  - `DEBUG`: Enable verbose logging.
"""
from contextlib import asynccontextmanager

async def simulation_tick_loop():
    """
    Background task that advances the digital twin physics every second.
    """
    svc = get_twin_service()
    while True:
        try:
            await svc.tick(dt_s=1.0)
        except Exception as e:
            print(f"[SIM LOOP ERROR] {e}")
        await asyncio.sleep(1.0)

@asynccontextmanager
async def lifespan(app: FastAPI):
    create_db_and_tables()
    # Start background loop
    task = asyncio.create_task(simulation_tick_loop())
    yield
    # Clean up (cancel task)
    task.cancel()

app = FastAPI(
    title="GridNinja Backend",
    version="0.2.0",
    description="Physics-informed control plane for Smart Grid + Data Center operations (Refactored).",
    lifespan=lifespan,
)

# Middleware (Order matters: Outer to Inner)
app.add_middleware(StructuredLoggerMiddleware)
app.add_middleware(RequestIDMiddleware)

# CORS: explicit origins for security
ALLOWED_ORIGINS = os.getenv("ALLOWED_ORIGINS", "http://localhost:3000").split(",")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in ALLOWED_ORIGINS],
    allow_credentials=False,  # False unless cookies are strictly needed
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

# ============================================================
# ROUTER REGISTRATION
# ============================================================

app.include_router(routes_health.router, tags=["Health"])
app.include_router(routes_telemetry.router, prefix="/telemetry", tags=["Telemetry"])
app.include_router(routes_decision.router, prefix="/decision", tags=["Decision"])
app.include_router(routes_trace.router, prefix="/trace", tags=["Trace"])
app.include_router(routes_kpi.router, prefix="/kpi", tags=["KPI"])
app.include_router(routes_grid.router, prefix="/grid", tags=["Grid"])
app.include_router(routes_ws.router, tags=["WebSocket"])


# ============================================================
# LOCAL RUN
# ============================================================
# uvicorn main:app --reload --port 8000
