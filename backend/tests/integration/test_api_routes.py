from fastapi.testclient import TestClient

def test_health_check(client: TestClient):
    response = client.get("/health")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "ok"
    assert "ts" in data

def test_decision_latest(client: TestClient):
    """Test the full decision pipeline via API."""
    params = {
        "deltaP_request_kw": 100.0,
        "grid_headroom_kw": 500.0,
        "P_site_kw": 1000.0
    }
    response = client.get("/decision/latest", params=params)
    assert response.status_code == 200
    data = response.json()
    
    assert "decision_id" in data
    assert data["requested_deltaP_kw"] == 100.0
    assert data["approved_deltaP_kw"] <= 100.0
    assert "plan" in data
    assert "trace" in data

def test_telemetry_timeseries(client: TestClient):
    """Verify telemetry generation."""
    response = client.get("/telemetry/timeseries?window_s=60")
    assert response.status_code == 200
    data = response.json()
    
    assert isinstance(data, list)
    assert len(data) == 60 # requested 60 points logic usually returns fixed or steps
    
    # check structure of first point
    p0 = data[0]
    assert "rack_temp_c" in p0
    assert "total_load_kw" in p0
    assert "safe_shift_kw" in p0

def test_kpi_summary(client: TestClient):
    response = client.get("/kpi/summary?window_s=900")
    assert response.status_code == 200
    data = response.json()
    
    assert "unsafe_actions_prevented_total" in data
    assert "blocked_rate_pct" in data
    assert "top_blocked_rules" in data
