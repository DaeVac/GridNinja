import os

from app.services.llm_explainer import explain_decision


def test_heuristic_post_mortem_thermal_block(monkeypatch):
    monkeypatch.setenv("EXPLAINER_ENABLED", "false")
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("GOOGLE_API_KEY", raising=False)

    decision = {
        "decision_id": "demo-thermal-1",
        "ts": "2026-01-01T12:00:00",
        "requested_deltaP_kw": -2000.0,
        "approved_deltaP_kw": 0.0,
        "blocked": True,
        "reason": "THERMAL_BLOCKED",
        "plan": {
            "reason": "THERMAL_BLOCKED",
            "primary_constraint": "THERMAL",
            "constraint_value": 52.3,
            "constraint_threshold": 50.0,
            "steps": [],
        },
        "trace": [
            {
                "rule_id": "THERMAL_OVER_TEMP",
                "status": "BLOCKED",
                "severity": "HIGH",
                "message": "Unsafe action prevented: thermal limit exceeded.",
                "value": 52.3,
                "threshold": 50.0,
            },
            {
                "rule_id": "GRID_HEADROOM_CLAMP",
                "status": "INFO",
                "severity": "LOW",
                "message": "Requested deltaP compared against grid headroom and limits.",
                "value": 2000.0,
                "threshold": 1500.0,
            },
        ],
    }

    result = explain_decision(decision)
    report = result["report_markdown"]

    assert result["from_llm"] is False
    assert result["cause"] == "THERMAL"
    assert "Post-Mortem Report (Deterministic)" in report
    assert "**Primary constraint:** THERMAL" in report
    assert "THERMAL_OVER_TEMP" in report
    assert "value=52.3" in report
    assert "threshold=50.0" in report
    assert "Increase cooling headroom" in report
