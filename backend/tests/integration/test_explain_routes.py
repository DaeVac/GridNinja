"""
test_explain_routes.py

Integration tests for the /explain endpoint.
"""
import time
from fastapi.testclient import TestClient


def test_explain_decision_with_blocked_payload(client: TestClient):
    """Test explain endpoint with a mock blocked decision."""
    mock_decision = {
        "ts": "2026-01-25T10:00:00Z",
        "decision_id": "test-123",
        "requested_deltaP_kw": 500.0,
        "approved_deltaP_kw": 0.0,
        "blocked": True,
        "reason": "THERMAL_LIMIT_EXCEEDED",
        "plan": {
            "requested_deltaP_kw": 500.0,
            "approved_deltaP_kw": 0.0,
            "blocked": True,
            "reason": "THERMAL_LIMIT_EXCEEDED",
            "primary_constraint": "THERMAL",
            "constraint_value": 52.5,
            "constraint_threshold": 50.0,
            "steps": []
        },
        "trace": [
            {
                "ts": "2026-01-25T10:00:00Z",
                "component": "THERMAL",
                "rule_id": "THERMAL_MAX_TEMP",
                "status": "BLOCKED",
                "severity": "HIGH",
                "message": "Rack temperature would exceed limit",
                "value": 52.5,
                "threshold": 50.0
            }
        ]
    }
    
    response = client.post(
        "/explain/decision",
        json={"decision": mock_decision}
    )
    
    assert response.status_code == 200
    data = response.json()
    
    # Verify response structure
    assert "report_markdown" in data
    assert "cause" in data
    assert "confidence" in data
    assert "from_llm" in data
    
    # Without API key, should use fallback
    assert data["from_llm"] is False
    assert data["cause"] == "THERMAL"
    assert "Post-Mortem" in data["report_markdown"]
    assert "THERMAL_MAX_TEMP" in data["report_markdown"]


def test_explain_decision_with_allowed_payload(client: TestClient):
    """Test explain endpoint with a mock allowed decision."""
    # Wait for rate limit to reset (1.5s cooldown in endpoint)
    time.sleep(2.0)
    mock_decision = {
        "ts": "2026-01-25T10:00:00Z",
        "decision_id": "test-456",
        "requested_deltaP_kw": 100.0,
        "approved_deltaP_kw": 100.0,
        "blocked": False,
        "reason": "OK",
        "plan": {
            "requested_deltaP_kw": 100.0,
            "approved_deltaP_kw": 100.0,
            "blocked": False,
            "reason": "OK",
            "steps": []
        },
        "trace": []
    }
    
    response = client.post(
        "/explain/decision",
        json={"decision": mock_decision}
    )
    
    assert response.status_code == 200
    data = response.json()
    
    assert "report_markdown" in data
    assert data["from_llm"] is False
    assert "Allowed" in data["report_markdown"]
