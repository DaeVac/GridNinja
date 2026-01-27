"""
grid_service_real.py

Purpose:
  Provides IEEE-33 bus topology (via pandapower) and SafeGNN headroom inference.

Key assumptions:
  - Bus labels are 1..33 (frontend), internal indices are 0..32 (pandapower/torch).
  - SafeGNN output is max safe additional load ΔP at a selected bus (kW).
  - DC bus default is 18 unless configured.

Primary endpoints that depend on this module:
  - GET /grid/topology
  - GET /grid/predict
"""
from __future__ import annotations

import os
from typing import Dict, List

from app.schemas.grid import GridTopologyResponse, GridPredictionResponse, GridNode, GridEdge
from app.config import env_flag
from app.services.pandapower_topology import PandapowerTopology
from app.services.gnn_service import GNNHeadroomService

class GridServiceReal:
    def __init__(self):
        self.demo_mode = env_flag("DEMO_MODE", False)
        self.allow_topology_fallback = env_flag("TOPOLOGY_FALLBACK", False) or self.demo_mode
        self.gnn_enabled = env_flag("GNN_ENABLED", True)

        self.topo = None
        self.topo_error = None
        try:
            self.topo = PandapowerTopology()
        except Exception as exc:
            self.topo_error = str(exc)

        # GNN: only initialize if enabled
        self.gnn = GNNHeadroomService() if self.gnn_enabled else None

        self.dc_bus = 18
        self.pv_buses = [6, 12, 18, 24, 30]
        self.substation_bus = 1

    def get_gnn_health(self) -> Dict[str, object]:
        model_path = None
        norm_path = None
        has_model = False
        has_norm = False
        if self.gnn is not None:
            model_path = getattr(self.gnn.cfg, "model_path", None)
            norm_path = getattr(self.gnn.cfg, "norm_path", None)
            if model_path:
                has_model = os.path.exists(model_path)
            if norm_path:
                has_norm = os.path.exists(norm_path)

        gnn_ready = self.gnn is not None and self.gnn.is_ready()

        return {
            "enabled": bool(self.gnn_enabled),
            "ready": bool(gnn_ready),
            "has_model": bool(has_model),
            "has_norm": bool(has_norm),
            "model_path": model_path,
            "norm_path": norm_path,
            "topology_source": "pandapower" if self.topo is not None else "fallback",
            "topology_error": self.topo_error,
        }

    def get_topology(self) -> GridTopologyResponse:
        if self.topo is not None:
            return self.topo.export_topology(
                dc_bus=self.dc_bus,
                pv_buses=self.pv_buses,
                substation_bus=self.substation_bus,
            )

        # If pandapower is unavailable, fall back even if demo flag not set
        if self.allow_topology_fallback or self.topo is None:
            return self._fallback_topology()

        raise RuntimeError(f"Topology unavailable: {self.topo_error or 'unknown error'}")

    def _fallback_topology(self) -> GridTopologyResponse:
        # Deterministic, lightweight topology for demo-only/offline runs.
        levels: List[int] = [1, 4, 8, 10, 10]  # totals 33 nodes
        nodes: List[GridNode] = []
        edges: List[GridEdge] = []
        label = 1

        prev_level_labels: List[int] = []
        for level_idx, count in enumerate(levels):
            level_labels: List[int] = []
            for i in range(count):
                label = len(nodes) + 1
                kind = "load"
                if label == self.substation_bus:
                    kind = "substation"
                elif label == self.dc_bus:
                    kind = "dc"
                elif label in self.pv_buses:
                    kind = "pv"

                x = level_idx * 160.0
                y = (i - (count - 1) / 2.0) * 80.0
                nodes.append(
                    GridNode(
                        id=str(label),
                        label=f"Bus {label}",
                        kind=kind,  # type: ignore[arg-type]
                        x=x,
                        y=y,
                    )
                )
                level_labels.append(label)

            if prev_level_labels:
                for idx, child in enumerate(level_labels):
                    parent = prev_level_labels[idx % len(prev_level_labels)]
                    edges.append(
                        GridEdge(
                            id=f"{parent}-{child}",
                            source=str(parent),
                            target=str(child),
                            r_ohm=0.05,
                            x_ohm=0.02,
                        )
                    )
            prev_level_labels = level_labels

        meta = {
            "bus_count": 33,
            "dc_bus": self.dc_bus,
            "pv_buses": self.pv_buses,
            "substation_bus": self.substation_bus,
            "source": "fallback.demo",
            "note": "Pandapower unavailable; demo topology fallback in use.",
        }

        return GridTopologyResponse(nodes=nodes, edges=edges, meta=meta)

    def predict_node(
        self,
        node_id: int,
        latest_telemetry: Dict,
    ) -> GridPredictionResponse:
        # Use your LIVE telemetry to set the DC load fed into the grid graph
        dc_p_kw = float(latest_telemetry.get("total_load_kw", 1000.0))

        # Predict for the clicked node
        gnn_active = self.gnn_enabled and self.gnn is not None and self.gnn.is_ready()
        gnn_ok = False
        if gnn_active:
            try:
                safe_shift_kw = self.gnn.predict_safe_shift_kw(
                    target_bus_label=node_id,
                    dc_bus_label=self.dc_bus,
                    dc_p_kw=dc_p_kw,
                )
                gnn_ok = True
            except Exception:
                safe_shift_kw = 800.0
                gnn_ok = False
        else:
            safe_shift_kw = float(min(1500.0, 1200.0))

        # Lightweight reason code for UI (you can refine later)
        freq = float(latest_telemetry.get("frequency_hz", 60.0))
        rack_temp = float(latest_telemetry.get("rack_temp_c", 42.0))

        reason = "OK"
        if not gnn_ok:
            reason = "GNN_DISABLED" if not self.gnn_enabled else "GNN_UNAVAILABLE_FALLBACK"
        if freq < 59.92:
            reason = "GRID_STRESS_CLAMP"
        if rack_temp > 48.0 and node_id == self.dc_bus:
            reason = "THERMAL_CLAMP"

        return GridPredictionResponse(
            node_id=str(node_id),
            safe_shift_kw=float(safe_shift_kw),
            confidence=0.85,
            reason_code=reason,
            debug={
                "dc_p_kw": dc_p_kw,
                "frequency_hz": freq,
                "rack_temp_c": rack_temp,
                "gnn_ok": 1.0 if gnn_ok else 0.0,
            },
        )
