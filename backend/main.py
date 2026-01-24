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
)

# ============================================================
# FASTAPI APP SETUP
# ============================================================

app = FastAPI(
    title="GridNinja Backend",
    version="0.2.0",
    description="Physics-informed control plane for Smart Grid + Data Center operations (Refactored).",
)

# CORS: allow local Next.js dev + hackathon flexibility
ALLOWED_ORIGINS = os.getenv("ALLOWED_ORIGINS", "*")
allow_origins = ["*"] if ALLOWED_ORIGINS == "*" else [o.strip() for o in ALLOWED_ORIGINS.split(",")]

app.add_middleware(
    CORSMiddleware,
    allow_origins=allow_origins,
    allow_credentials=True,
    allow_methods=["*"],
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


# ============================================================
# LOCAL RUN
# ============================================================
# uvicorn main:app --reload --port 8000
