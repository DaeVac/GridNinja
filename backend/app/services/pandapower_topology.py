"""
pandapower_topology.py

Purpose:
  Provides the "Ground Truth" physical grid layout using the `pandapower` library.
  It maps the standard IEEE-33 radial distribution definition to a graph structure (Nodes/Edges).

Key Mappings:
  - **Bus Labels**: Frontend uses 1-based indexing (1..33). Pandapower internal indices are 0..32.
    This module handles the translation transparently.
  - **Resistance/Reactance (R/X)**: Computed from line length (km) * specific impedance (ohm/km).

Layout Algorithm:
  - Uses a **Breadth-First Search (BFS)** starting from the substation (Bus 1) to determine
    depth levels. This ensures a stable, consistent tree visualization regardless of specific
    branch ordering in the file.
"""
from __future__ import annotations

from collections import deque, defaultdict
import math
from typing import Dict, List, Tuple, Optional

try:
    import pandapower as pp
    import pandapower.networks as pn
    HAS_PANDAPOWER = True
except Exception:
    pp = None  # type: ignore
    pn = None  # type: ignore
    HAS_PANDAPOWER = False

from app.schemas.grid import GridTopologyResponse, GridNode, GridEdge

class PandapowerTopology:
    """
    Real IEEE-33 topology source of truth from pandapower case33bw().
    Extracts:
      - nodes (buses)
      - edges (lines)
      - edge attributes (R/X)
      - stable 2D layout (BFS radial)
    """

    def __init__(self):
        if not HAS_PANDAPOWER:
            raise RuntimeError("pandapower is not installed")
        # Cache the network structure to avoid rebuilding heavily
        self.net = pn.case33bw()  # IEEE 33-bus Baran & Wu case

        # Bus "labels" exposed to frontend: 1..33
        # pandapower indices are 0..32, but names are often 1..33. We normalize.
        self.bus_labels = self._build_bus_labels()

        # Lines
        self.lines = self._extract_lines()

        # Layout
        self.pos = self._layout_bfs(root_label=1)

    def _build_bus_labels(self) -> Dict[int, int]:
        """
        Map internal bus index -> external label (1..33).
        """
        labels = {}
        for idx in self.net.bus.index:
            name = self.net.bus.at[idx, "name"]
            try:
                # name might already be numeric
                label = int(name)
            except Exception:
                label = int(idx) + 1
            labels[int(idx)] = label
        return labels

    def _extract_lines(self) -> List[Tuple[int, int, int, float, float]]:
        """
        Returns list: (line_idx, from_label, to_label, r_ohm, x_ohm)
        """
        out = []
        for i in self.net.line.index:
            fb = int(self.net.line.at[i, "from_bus"])
            tb = int(self.net.line.at[i, "to_bus"])

            from_label = self.bus_labels[fb]
            to_label = self.bus_labels[tb]

            # r/x ohms = per_km * length_km
            r = float(self.net.line.at[i, "r_ohm_per_km"]) * float(self.net.line.at[i, "length_km"])
            x = float(self.net.line.at[i, "x_ohm_per_km"]) * float(self.net.line.at[i, "length_km"])

            out.append((int(i), from_label, to_label, r, x))
        return out

    def _layout_bfs(self, root_label: int = 1) -> Dict[int, Tuple[float, float]]:
        """
        Very stable, readable layout for radial networks using BFS levels.
        """
        adj = defaultdict(list)
        for _, a, b, _, _ in self.lines:
            adj[a].append(b)
            adj[b].append(a)

        depth = {root_label: 0}
        parent = {root_label: None}
        q = deque([root_label])

        while q:
            u = q.popleft()
            for v in adj[u]:
                if v not in depth:
                    depth[v] = depth[u] + 1
                    parent[v] = u
                    q.append(v)

        # Group nodes by depth
        levels = defaultdict(list)
        for node, d in depth.items():
            levels[d].append(node)

        # Assign positions
        pos = {}
        x_gap = 150.0
        y_gap = 80.0

        for d in sorted(levels.keys()):
            nodes = sorted(levels[d])
            for j, node in enumerate(nodes):
                x = d * x_gap
                y = (j - (len(nodes) - 1) / 2) * y_gap
                pos[node] = (x, y)

        # Ensure all labels exist (fallback)
        for label in range(1, 34):
            if label not in pos:
                pos[label] = (0.0, 0.0)

        return pos

    def export_topology(
        self,
        dc_bus: int = 18,
        pv_buses: List[int] | None = None,
        substation_bus: int = 1,
        alleviation_text: Optional[str] = None,
        alleviation_by_branch: Optional[Dict[str, str]] = None,
    ) -> GridTopologyResponse:
        pv_buses = pv_buses or [6, 12, 18, 24, 30]

        bus_vpu: Dict[int, float] = {}
        line_metrics: Dict[int, Dict[str, float]] = {}

        if pp is not None:
            try:
                pp.runpp(self.net, calculate_voltage_angles=False)
                for bus_idx in self.net.bus.index:
                    label = self.bus_labels[int(bus_idx)]
                    vm_pu = self.net.res_bus.at[bus_idx, "vm_pu"]
                    if vm_pu is not None and math.isfinite(float(vm_pu)):
                        bus_vpu[label] = float(vm_pu)

                for line_idx in self.net.line.index:
                    res = self.net.res_line.loc[line_idx]
                    loading = res.get("loading_percent", None)
                    p_from = res.get("p_from_mw", None)
                    metrics: Dict[str, float] = {}
                    if loading is not None and math.isfinite(float(loading)):
                        metrics["loading_pct"] = float(loading)
                        metrics["margin_pct"] = max(0.0, 100.0 - float(loading))
                    if p_from is not None and math.isfinite(float(p_from)):
                        metrics["p_mw"] = float(p_from)

                    # Optional thermal rating estimate (MVA) based on max_i_ka & bus voltage.
                    try:
                        max_i_ka = float(self.net.line.at[line_idx, "max_i_ka"])
                        from_bus_idx = int(self.net.line.at[line_idx, "from_bus"])
                        vn_kv = float(self.net.bus.at[from_bus_idx, "vn_kv"])
                        metrics["rating_mva"] = math.sqrt(3.0) * vn_kv * max_i_ka
                    except Exception:
                        pass

                    if metrics:
                        line_metrics[int(line_idx)] = metrics
            except Exception:
                bus_vpu = {}
                line_metrics = {}

        nodes: List[GridNode] = []
        for label in range(1, 34):
            kind = "load"
            if label == substation_bus:
                kind = "substation"
            elif label == dc_bus:
                kind = "dc"
            elif label in pv_buses:
                kind = "pv"

            x, y = self.pos[label]
            nodes.append(
                GridNode(
                    id=str(label),
                    label=f"Bus {label}",
                    kind=kind,
                    x=x,
                    y=y,
                    v_pu=bus_vpu.get(label),
                )
            )

        edges: List[GridEdge] = []
        max_loading = -1.0
        max_loading_edge_id: Optional[str] = None
        for (line_idx, a, b, r, x) in self.lines:
            metrics = line_metrics.get(int(line_idx), {})
            loading_pct = metrics.get("loading_pct")
            if loading_pct is not None and loading_pct > max_loading:
                max_loading = loading_pct
                max_loading_edge_id = f"{a}-{b}"
            edges.append(
                GridEdge(
                    id=f"{a}-{b}",
                    source=str(a),
                    target=str(b),
                    r_ohm=r,
                    x_ohm=x,
                    p_mw=metrics.get("p_mw"),
                    loading_pct=metrics.get("loading_pct"),
                    rating_mva=metrics.get("rating_mva"),
                    margin_pct=metrics.get("margin_pct"),
                )
            )

        alleviation_by_branch = alleviation_by_branch or {}
        if alleviation_text:
            if max_loading_edge_id is None and edges:
                max_loading_edge_id = edges[0].id
            if max_loading_edge_id:
                alleviation_by_branch.setdefault(max_loading_edge_id, alleviation_text)

        if alleviation_by_branch:
            for edge in edges:
                if edge.id in alleviation_by_branch:
                    edge.alleviation = alleviation_by_branch[edge.id]

        meta = {
            "bus_count": 33,
            "dc_bus": dc_bus,
            "pv_buses": pv_buses,
            "substation_bus": substation_bus,
            "source": "pandapower.case33bw",
        }

        return GridTopologyResponse(nodes=nodes, edges=edges, meta=meta)
