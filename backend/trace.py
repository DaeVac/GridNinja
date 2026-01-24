# apps/backend/app/schemas/trace.py
from typing import Dict, List
from pydantic import BaseModel


class TraceLatestResponse(BaseModel):
    ts: str
    events: List[Dict]
