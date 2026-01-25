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
from typing import Dict

from app.schemas.grid import GridTopologyResponse, GridPredictionResponse
from app.services.pandapower_topology import PandapowerTopology
from app.services.gnn_service import GNNHeadroomService

class GridServiceReal:
    def __init__(self):
        self.topo = PandapowerTopology()

        model_path = os.path.join("models", "safe_gnn_model.pth")
        # norm_path = os.path.join("models", "norm_stats.json") # If json
        # We are using .pt files for stats per previous fix, GNNHeadroomService handles that via config defaults if we don't pass override
        # We can just rely on GNNHeadroomService default config scanning.

        self.gnn = GNNHeadroomService() # Uses default paths in models/ which we verified are correct

        self.dc_bus = 18
        self.pv_buses = [6, 12, 18, 24, 30]
        self.substation_bus = 1

    def get_topology(self) -> GridTopologyResponse:
        return self.topo.export_topology(
            dc_bus=self.dc_bus,
            pv_buses=self.pv_buses,
            substation_bus=self.substation_bus,
        )

    def predict_node(
        self,
        node_id: int,
        latest_telemetry: Dict,
    ) -> GridPredictionResponse:
        # Use your LIVE telemetry to set the DC load fed into the grid graph
        dc_p_kw = float(latest_telemetry.get("total_load_kw", 1000.0))

        # Predict for the clicked node
        safe_shift_kw = self.gnn.predict_safe_shift_kw(
            target_bus_label=node_id,
            dc_bus_label=self.dc_bus,
            dc_p_kw=dc_p_kw,
        )

        # Lightweight reason code for UI (you can refine later)
        freq = float(latest_telemetry.get("frequency_hz", 60.0))
        rack_temp = float(latest_telemetry.get("rack_temp_c", 42.0))

        reason = "OK"
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
            },
        )
