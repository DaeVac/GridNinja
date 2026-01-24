from fastapi.testclient import TestClient
from unittest.mock import MagicMock, patch

def test_decision_gnn_override(client: TestClient):
    """
    Test that decision endpoint uses GNN when grid_headroom_kw is missing.
    """
    with patch("app.api.routes_decision.get_twin_service") as mock_get_svc:
        mock_svc = MagicMock()
        mock_get_svc.return_value = mock_svc
        
        # Mock GNN
        mock_gnn = MagicMock()
        mock_gnn.is_ready.return_value = True
        mock_gnn.predict_safe_shift_kw.return_value = 1111.0 # Distinct value
        
        mock_svc.gnn = mock_gnn
        
        # Mock decide response
        mock_svc.decide.return_value = {
            "decision_id": "test-uuid",
            "approved_deltaP_kw": 0.0,
            "status": "APPROVED",
            "trace": []
        }
        
        # Call without grid_headroom_kw
        response = client.get("/decision/latest?deltaP_request_kw=500&P_site_kw=1000")
        
        assert response.status_code == 200
        data = response.json()
        
        # Check that predicted value was passed to decide
        # We can't easily check arguments passed to mock_svc.decide from client response 
        # unless we check the trace we injected.
        
        trace = data.get("trace", [])
        sources = [t for t in trace if t["rule_id"] == "HEADROOM_SOURCE"]
        assert len(sources) == 1
        assert sources[0]["message"] == "Headroom determined by GNN"
        assert sources[0]["value"] == 1111.0

def test_decision_manual_override(client: TestClient):
    """
    Test that decision endpoint respects manual grid_headroom_kw.
    """
    with patch("app.api.routes_decision.get_twin_service") as mock_get_svc:
        mock_svc = MagicMock()
        mock_get_svc.return_value = mock_svc
        mock_svc.gnn = None # No GNN needed
        
        mock_svc.decide.return_value = {
            "decision_id": "test-uuid",
            "approved_deltaP_kw": 0.0,
            "status": "APPROVED",
            "trace": []
        }
        
        # Call WITH grid_headroom_kw
        response = client.get("/decision/latest?deltaP_request_kw=500&P_site_kw=1000&grid_headroom_kw=2000")
        
        assert response.status_code == 200
        data = response.json()
        
        trace = data.get("trace", [])
        sources = [t for t in trace if t["rule_id"] == "HEADROOM_SOURCE"]
        assert len(sources) == 1
        assert sources[0]["message"] == "Headroom determined by MANUAL"
        assert sources[0]["value"] == 2000.0
