import pytest
from unittest.mock import MagicMock, patch
from app.services.digital_twin import DigitalTwinService
from app.services.gnn_service import GNNHeadroomService
from app.models.domain import RuleStatus

def test_gnn_clamping_logic():
    """
    Verify that if GNN predicts a lower headroom than the grid signal,
    the decision logic clamps the headroom and logs a trace event.
    """
    # 1. Mock GNN Service
    mock_gnn = MagicMock(spec=GNNHeadroomService)
    mock_gnn.is_ready.return_value = True
    # Predict a strict limit (500 kW) vs Grid Signal (1500 kW)
    mock_gnn.predict_safe_shift_kw.return_value = 500.0

    # 2. Convert to DigitalTwinService with mocked GNN
    # We patch torch to avoid synthesis errors if torch isn't installed in test env
    with patch("app.services.digital_twin.torch") as mock_torch:
        # Mock tensor creation to simple dummy
        mock_torch.zeros.return_value = MagicMock()
        mock_torch.rand.return_value = MagicMock()
        
        svc = DigitalTwinService(gnn=mock_gnn)
        
        # 3. Request Decision
        # Request 400kW (safe for GNN) but Grid offers 1500kW
        # We expect the planner to use 500kW as the cap, not 1500kW.
        # Although 400 < 500, the Clamp logic happens *before* planning.
        # To test clamping effect, let's request MORE than GNN but LESS than Grid.
        # Request: 800 kW. Grid: 1500 kW. GNN: 500 kW.
        # Expectation: Blocked or clamped to 500 kW (if batteries allow).
        # Actually, policy engine limits to `headroom`. 
        # So providing 800kW request with effective headroom=500kW should:
        # - Be capped at 500kW (if using binary search for max) OR
        # - Be Blocked/Partially Approved depending on logic.
        
        # Let's check the TRACE to see if the clamp event happened.
        result = svc.decide(
            deltaP_request_kw=800.0,
            P_site_kw=1000.0,
            grid_headroom_kw=1500.0
        )
        
        trace = result["trace"]
        
        # 4. Assert GNN Clamping Happened
        gnn_events = [e for e in trace if e["rule_id"] == "GNN_HEADROOM_CAP"]
        assert len(gnn_events) == 1, "Should have exactly one GNN clamping event"
        
        evt = gnn_events[0]
        assert evt["component"] == "GNN"
        assert evt["status"] == RuleStatus.INFO.value
        assert evt["threshold"] == 1500.0
        assert evt["value"] == 500.0
        assert "clamped grid headroom" in evt["message"]

        # 5. Assert Final Decision Respects Limit
        # approved_deltaP_kw should be <= 500.0
        approved = result["approved_deltaP_kw"]
        assert approved <= 500.0 + 1e-6, f"Approved {approved} exceeded GNN limit 500.0"

def test_gnn_inactive_no_clamping():
    """
    Verify that if GNN is not ready, we use the raw grid headroom.
    """
    mock_gnn = MagicMock(spec=GNNHeadroomService)
    mock_gnn.is_ready.return_value = False # NOT READY
    
    svc = DigitalTwinService(gnn=mock_gnn)
    
    result = svc.decide(
        deltaP_request_kw=800.0,
        P_site_kw=1000.0,
        grid_headroom_kw=1500.0
    )
    
    trace = result["trace"]
    gnn_events = [e for e in trace if e["rule_id"] == "GNN_HEADROOM_CAP"]
    assert len(gnn_events) == 0, "Should NOT have GNN clamping event if GNN is not ready"
