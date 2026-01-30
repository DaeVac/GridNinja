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
    v_pu: Optional[float] = None
    criticality: Optional[float] = None

class GridEdge(BaseModel):
    id: str                 # "1-2"
    source: str
    target: str
    r_ohm: float
    x_ohm: float
    p_mw: Optional[float] = None
    loading_pct: Optional[float] = None
    rating_mva: Optional[float] = None
    thermal_limit_mw: Optional[float] = None
    margin_pct: Optional[float] = None
    alleviation: Optional[str] = None

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
