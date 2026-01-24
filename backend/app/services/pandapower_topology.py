from __future__ import annotations

from collections import deque, defaultdict
from typing import Dict, List, Tuple, Optional

import pandapower.networks as pn

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

    def _extract_lines(self) -> List[Tuple[int, int, float, float]]:
        """
        Returns list: (from_label, to_label, r_ohm, x_ohm)
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

            out.append((from_label, to_label, r, x))
        return out

    def _layout_bfs(self, root_label: int = 1) -> Dict[int, Tuple[float, float]]:
        """
        Very stable, readable layout for radial networks using BFS levels.
        """
        adj = defaultdict(list)
        for a, b, _, _ in self.lines:
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
    ) -> GridTopologyResponse:
        pv_buses = pv_buses or [6, 12, 18, 24, 30]

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
                )
            )

        edges: List[GridEdge] = []
        for (a, b, r, x) in self.lines:
            edges.append(
                GridEdge(
                    id=f"{a}-{b}",
                    source=str(a),
                    target=str(b),
                    r_ohm=r,
                    x_ohm=x,
                )
            )

        meta = {
            "bus_count": 33,
            "dc_bus": dc_bus,
            "pv_buses": pv_buses,
            "substation_bus": substation_bus,
            "source": "pandapower.case33bw",
        }

        return GridTopologyResponse(nodes=nodes, edges=edges, meta=meta)
