from __future__ import annotations

import asyncio
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.deps import get_twin_service

router = APIRouter()

@router.websocket("/ws/telemetry")
async def ws_telemetry(websocket: WebSocket):
    """
    WebSocket stream of the latest telemetry point every 1s.
    Matches your SSE payload shape so the frontend can switch easily.
    """
    await websocket.accept()
    svc = get_twin_service()

    try:
        while True:
            # Efficiently pull the cached latest point
            latest = svc.get_latest_telemetry()
            if latest:
                await websocket.send_json(latest)

            await asyncio.sleep(1.0)

    except WebSocketDisconnect:
        # normal disconnect
        return
    except Exception:
        try:
            await websocket.close()
        except Exception:
            pass
