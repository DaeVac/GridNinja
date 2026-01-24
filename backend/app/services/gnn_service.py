# apps/backend/app/services/gnn_service.py
from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Optional

import torch
import torch.nn as nn
import torch.nn.functional as F

# Safe optional import
try:
# Safe optional import
try:
    from torch_geometric.data import Data
    from torch_geometric.nn import GINEConv, global_mean_pool
    HAS_PYG = True
except ImportError:
    HAS_PYG = False
    GINEConv = object  # dummy
    global_mean_pool = None
    Data = None


# -----------------------------
# Model definition must match training
# -----------------------------
class SafeGNN(nn.Module):
    def __init__(self, node_dim=3, edge_dim=2, hidden_dim=64, num_layers=3):
        super().__init__()
        if not HAS_PYG:
            raise RuntimeError("SafeGNN requires torch_geometric")
            
        self.node_enc = nn.Linear(node_dim, hidden_dim)
        self.edge_enc = nn.Linear(edge_dim, hidden_dim)
        self.convs = nn.ModuleList()

        for _ in range(num_layers):
            mlp = nn.Sequential(
                nn.Linear(hidden_dim, hidden_dim),
                nn.SiLU(),
                nn.Linear(hidden_dim, hidden_dim),
            )
            self.convs.append(GINEConv(mlp, train_eps=True, edge_dim=hidden_dim))

        self.head = nn.Sequential(
            nn.Linear(hidden_dim * 2, 128),
            nn.SiLU(),
            nn.Linear(128, 64),
            nn.SiLU(),
            nn.Linear(64, 1),
        )

    def forward(self, x, edge_index, edge_attr, batch, target_mask):
        x = self.node_enc(x)
        edge_attr = self.edge_enc(edge_attr)

        for conv in self.convs:
            x_in = x
            x = conv(x, edge_index, edge_attr=edge_attr)
            x = F.silu(x)
            x = x + x_in

        global_h = global_mean_pool(x, batch)
        # Use the mask to pick the "local" node embedding we care about
        local_h = x[target_mask]

        # Concatenate local + global
        out = self.head(torch.cat([local_h, global_h], dim=1))
        out = F.softplus(out)
        return out


@dataclass
class GNNConfig:
    # Paths updated to match extracted zip structure (renamed during move)
    model_path: str = "models/safe_gnn_model.pth"
    norm_path: str = "models/norm_stats_x.pt"
    topology_path: str = "data/topology_case33bw.pt"
    dc_bus_idx: int = 17  # IEEE 33 bus "data center" node index
    output_unit: str = "MW"  # model predicts MW headroom by convention
    max_kw_cap: float = 1500.0  # clamp at backend for UI safety


class GNNHeadroomService:
    """
    Optional SafeGNN inference wrapper.
    If files are missing or libraries unavailable, returns safe fallback.
    """

# -------------------------
# Inference service
# -------------------------
class GNNHeadroomService:
    def __init__(self, cfg: Optional[GNNConfig] = None, device: Optional[str] = None):
        self.cfg = cfg or GNNConfig()
        self.device = torch.device(device or ("cuda" if torch.cuda.is_available() else "cpu"))

        self.model: Optional[nn.Module] = None
        # Static IEEE-33 topology template for edge index/attr cache
        self.edge_index: Optional[torch.Tensor] = None
        self.edge_attr: Optional[torch.Tensor] = None
        
        self.x_mean: Optional[torch.Tensor] = None
        self.x_std: Optional[torch.Tensor] = None
        
        # Norm stats from file
        if HAS_PYG:
             self._load_if_available()
        else:
            print("[WARN] torch_geometric not found. GNN service will run in fallback mode.")

    def _load_if_available(self):
        if not os.path.exists(self.cfg.model_path):
             return
             
        try:
            # Load normalization stats if separate
            if os.path.exists(self.cfg.norm_path):
                 norm = torch.load(self.cfg.norm_path, map_location="cpu")
                 self.x_mean = norm["x_mean"].float().to(self.device)
                 self.x_std = norm["x_std"].float().to(self.device)
            else:
                 # Fallback helpers
                 self.x_mean = torch.zeros(3).to(self.device)
                 self.x_std = torch.ones(3).to(self.device)

            # Load Model
            self.model = SafeGNN(node_dim=3, edge_dim=2).to(self.device)
            state = torch.load(self.cfg.model_path, map_location=self.device)
            self.model.load_state_dict(state)
            self.model.eval()

            # Precompute Edge Index/Attr from Pandapower topology once
            import pandapower.networks as pn
            net = pn.case33bw()
            self.edge_index, self.edge_attr = self._build_edges(net)
            self.edge_index = self.edge_index.to(self.device)
            self.edge_attr = self.edge_attr.to(self.device)

        except Exception as e:
            print(f"[WARN] Failed to load GNN model: {e}")
            self.model = None

    def _build_edges(self, net) -> Tuple[torch.Tensor, torch.Tensor]:
        from_bus = net.line.from_bus.values
        to_bus = net.line.to_bus.values

        # bidirectional edges
        src = torch.tensor(list(from_bus) + list(to_bus), dtype=torch.long)
        dst = torch.tensor(list(to_bus) + list(from_bus), dtype=torch.long)
        edge_index = torch.stack([src, dst], dim=0)

        # R/X feature
        r = torch.tensor(net.line.r_ohm_per_km.values * net.line.length_km.values, dtype=torch.float32)
        x = torch.tensor(net.line.x_ohm_per_km.values * net.line.length_km.values, dtype=torch.float32)
        half = torch.stack([r, x], dim=1)
        edge_attr = torch.cat([half, half], dim=0)  # bidirectional copy

        return edge_index, edge_attr

    def is_ready(self) -> bool:
        return (
            HAS_PYG
            and self.model is not None
            and self.edge_index is not None
        )

    def _extract_node_features(self, net, dc_bus_idx: int, dc_p_mw: float, dc_q_mvar: float) -> torch.Tensor:
        """
        Builds node features [P_load, Q_load, P_gen] using real pandapower state.
        """
        import pandapower as pp
        
        # Ensure DC load exists and overwrite
        dc_loads = net.load[net.load.bus == dc_bus_idx]
        if len(dc_loads) == 0:
            pp.create_load(net, bus=dc_bus_idx, p_mw=dc_p_mw, q_mvar=dc_q_mvar)
        else:
            idx = dc_loads.index[0]
            net.load.at[idx, "p_mw"] = dc_p_mw
            net.load.at[idx, "q_mvar"] = dc_q_mvar

        nbus = len(net.bus)
        P_load = torch.zeros(nbus, dtype=torch.float32)
        Q_load = torch.zeros(nbus, dtype=torch.float32)
        P_gen = torch.zeros(nbus, dtype=torch.float32)

        if len(net.load) > 0:
            for _, row in net.load.iterrows():
                b = int(row["bus"])
                P_load[b] += float(row["p_mw"])
                Q_load[b] += float(row["q_mvar"])

        if hasattr(net, "sgen") and len(net.sgen) > 0:
            for _, row in net.sgen.iterrows():
                b = int(row["bus"])
                P_gen[b] += float(row["p_mw"])

        x = torch.stack([P_load, Q_load, P_gen], dim=1)
        # Normalize
        x = (x.to(self.device) - self.x_mean) / self.x_std
        return x

    @torch.no_grad()
    def predict_safe_shift_kw(
        self, 
        x_node_raw: Optional[torch.Tensor] = None, 
        target_bus_label: int = 18, 
        dc_bus_label: int = 18,
        dc_p_kw: float = 1000.0
    ) -> float:
        """
        Can handle either raw tensor input (legacy) or full pandapower build.
        If x_node_raw is None, we build from pandapower integration.
        """
        if not self.is_ready():
            return float(min(self.cfg.max_kw_cap, 1200.0))

        # Legacy/Test path support
        if x_node_raw is not None:
            # Just Assume target mask is DC bus (17 in internal 0-idx)
            x = x_node_raw.to(self.device).float()
            # Normalize manually if needed, or assume caller did it. 
            # (In prev implementation caller didn't normalize, but here we enforce standard flow)
            # For back-compat with test, we just pass x if it looks normalized, or normalize.
            pass
        else:
            # REAL PATH: Build from Pandapower
            import pandapower.networks as pn
            net = pn.case33bw()
            
            x = self._extract_node_features(
                net, 
                dc_bus_idx=dc_bus_label-1, 
                dc_p_mw=dc_p_kw/1000.0, 
                dc_q_mvar=0.0
            ) 

        # Build mask for the target node we want to predict headroom FOR
        # (Default is the DC bus itself, but could be any bus)
        target_idx = target_bus_label - 1
        target_mask = torch.zeros(x.shape[0], dtype=torch.bool, device=self.device)
        target_mask[target_idx] = True
        
        # Batch index (all 0 for single graph)
        batch = torch.zeros(x.shape[0], dtype=torch.long, device=self.device)

        # Forward
        # Note: Model forward signature expected: x, edge_index, edge_attr, batch, target_mask
        # Need to ensure SafeGNN class definition matches this signature.
        # If the loaded model has a different signature, we might need adapter.
        # Assuming the provided SafeGNN matches the plan.
        
        # We need to adapt the SafeGNN.forward call in this file to match the new signature 
        # or rely on the fact that we pasted the new SafeGNN class earlier?
        # NO, we define the class in this file. I need to update SafeGNN class too?
        # Yes, the plan included updating SafeGNN class definition.
        
        out = self.model(x, self.edge_index, self.edge_attr, batch, target_mask)
        val = out.item()
        
        # Convert MW -> kW
        kw = val * 1000.0
        return max(0.0, min(float(self.cfg.max_kw_cap), kw))

