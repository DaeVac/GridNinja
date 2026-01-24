from __future__ import annotations
from typing import Dict, List, Optional, Literal
from pydantic import BaseModel

NodeKind = Literal["substation", "dc", "pv", "load"]

class GridNode(BaseModel):
    id: str                 # "1".."33" (bus label)
    label: str              # "Bus 18"
    kind: NodeKind
    x: float
    y: float

class GridEdge(BaseModel):
    id: str                 # "1-2"
    source: str
    target: str
    r_ohm: float
    x_ohm: float

class GridTopologyResponse(BaseModel):
    nodes: List[GridNode]
    edges: List[GridEdge]
    meta: Dict[str, object]

class GridPredictionResponse(BaseModel):
    node_id: str
    safe_shift_kw: float
    confidence: float
    reason_code: str
    debug: Optional[Dict[str, float]] = None
