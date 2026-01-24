from fastapi.testclient import TestClient
import math

def test_safety_guardrails_huge_value(client: TestClient):
    """Ensure excessive values are rejected."""
    params = {
        "deltaP_request_kw": 100000.0, # > 5000 limit
        "grid_headroom_kw": 500.0,
        "P_site_kw": 1000.0
    }
    response = client.get("/decision/latest", params=params)
    assert response.status_code == 422 # Unprocessable Entity
    
def test_safety_guardrails_nan(client: TestClient):
    """Ensure NaN is rejected."""
    params = {
        "deltaP_request_kw": float("nan"),
        "grid_headroom_kw": 500.0,
        "P_site_kw": 1000.0
    }
    response = client.get("/decision/latest", params=params)
    # The Pydantic validation or our manual check should catch this
    # Note: different fastapi versions handle NaN for 'float' differently, 
    # but our manual check guarantees 422 even if Pydantic let it pass.
    assert response.status_code == 422

def test_request_id_middleware(client: TestClient):
    """Ensure X-Request-ID header is present."""
    response = client.get("/health")
    assert response.status_code == 200
    assert "X-Request-ID" in response.headers
    assert len(response.headers["X-Request-ID"]) > 10
