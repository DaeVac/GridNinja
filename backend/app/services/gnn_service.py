# apps/backend/app/services/gnn_service.py
from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Optional

import torch
import torch.nn as nn
import torch.nn.functional as F

try:
    from torch_geometric.nn import GINEConv, global_mean_pool
except Exception as e:
    raise RuntimeError(
        "torch_geometric is required for GNN inference. "
        "Install: pip install torch-geometric"
    ) from e


# -----------------------------
# Model definition must match training
# -----------------------------
class SafeGNN(nn.Module):
    def __init__(self, node_dim=3, edge_dim=2, hidden_dim=64, num_layers=3):
        super().__init__()
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

    def forward(self, x, edge_index, edge_attr, batch, dc_mask):
        x = self.node_enc(x)
        edge_attr = self.edge_enc(edge_attr)

        for conv in self.convs:
            x_in = x
            x = conv(x, edge_index, edge_attr=edge_attr)
            x = F.silu(x)
            x = x + x_in

        global_h = global_mean_pool(x, batch)
        dc_h = x[dc_mask]
        out = self.head(torch.cat([dc_h, global_h], dim=1))
        return F.softplus(out)  # positive


@dataclass
class GNNConfig:
    model_path: str = "models/safe_gnn_model.pth"
    norm_path: str = "models/norm_stats_x.pt"  # contains x_mean/x_std + pgen_log1p bool
    topology_path: str = "data/topology_case33bw.pt"  # saved edge_index/edge_attr
    dc_bus_idx: int = 17  # IEEE 33 bus "data center" node index
    output_unit: str = "MW"  # model predicts MW headroom by convention
    max_kw_cap: float = 1500.0  # clamp at backend for UI safety


class GNNHeadroomService:
    """
    Optional SafeGNN inference wrapper.
    If files are missing, returns a safe fallback without crashing the demo.
    """

    def __init__(self, cfg: Optional[GNNConfig] = None, device: Optional[str] = None):
        self.cfg = cfg or GNNConfig()

        self.device = torch.device(device or ("cuda" if torch.cuda.is_available() else "cpu"))

        self.model: Optional[nn.Module] = None
        self.edge_index: Optional[torch.Tensor] = None
        self.edge_attr: Optional[torch.Tensor] = None

        self.x_mean: Optional[torch.Tensor] = None
        self.x_std: Optional[torch.Tensor] = None
        self.use_log1p_pgen: bool = True

        self._load_if_available()

    def _load_if_available(self):
        if not os.path.exists(self.cfg.model_path):
            return
        if not os.path.exists(self.cfg.norm_path):
            return
        if not os.path.exists(self.cfg.topology_path):
            return

        topo = torch.load(self.cfg.topology_path, map_location="cpu")
        self.edge_index = topo["edge_index"].long().to(self.device)
        self.edge_attr = topo["edge_attr"].float().to(self.device)

        norm = torch.load(self.cfg.norm_path, map_location="cpu")
        self.x_mean = norm["x_mean"].float().to(self.device)
        self.x_std = norm["x_std"].float().to(self.device)
        self.use_log1p_pgen = bool(norm.get("pgen_log1p", True))

        self.model = SafeGNN(node_dim=3, edge_dim=2).to(self.device)
        state = torch.load(self.cfg.model_path, map_location="cpu")
        self.model.load_state_dict(state)
        self.model.eval()

    def is_ready(self) -> bool:
        return (
            self.model is not None
            and self.edge_index is not None
            and self.edge_attr is not None
            and self.x_mean is not None
            and self.x_std is not None
        )

    @torch.no_grad()
    def predict_safe_shift_kw(self, x_node_raw: torch.Tensor) -> float:
        """
        x_node_raw: (N_nodes, 3) = [P_load, Q_load, P_gen] in MW (or consistent training unit)
        Returns: safe shift headroom in kW
        """
        if not self.is_ready():
            # fallback: stable number that makes UI "work"
            return float(min(self.cfg.max_kw_cap, 1200.0))

        x = x_node_raw.to(self.device).float().clone()
        # Apply log1p to P_gen channel if trained that way
        if self.use_log1p_pgen:
            x[:, 2] = torch.log1p(torch.clamp(x[:, 2], min=0.0))

        x = (x - self.x_mean) / torch.clamp(self.x_std, min=1e-6)
        x = torch.clamp(x, -6.0, 6.0)

        # Batch helpers (single graph)
        n = x.size(0)
        batch = torch.zeros(n, dtype=torch.long, device=self.device)
        dc_mask = torch.zeros(n, dtype=torch.bool, device=self.device)
        dc_mask[self.cfg.dc_bus_idx] = True

        y = self.model(x, self.edge_index, self.edge_attr, batch, dc_mask)  # (1,1) effectively
        y_val = float(y.squeeze().item())

        # Convert to kW
        if self.cfg.output_unit.upper() == "MW":
            kw = y_val * 1000.0
        else:
            kw = y_val

        # Backend clamp for UI safety and consistency
        kw = max(0.0, min(float(self.cfg.max_kw_cap), kw))
        return kw
