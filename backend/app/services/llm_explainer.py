"""
LLM Explainer Service

Purpose:
  Uses Gemini 1.5 Pro to generate human-readable "Post-Mortem Reports"
  explaining why a controller decision was blocked or clipped.

Features:
  - Gemini SDK integration (google-genai)
  - Heuristic fallback when no API key is configured
  - Payload shrinking to reduce token costs
"""
from __future__ import annotations

import json
import os
from typing import Any, Dict, List, Optional, Tuple

from app.config import env_flag

# Gemini SDK (Google Gen AI Python SDK)
try:
    from google import genai
    GENAI_AVAILABLE = True
except ImportError:
    GENAI_AVAILABLE = False

DEFAULT_MODEL = os.getenv("GEMINI_MODEL_ID", "gemini-1.5-pro")

SYSTEM_INSTRUCTIONS = """
You are a Senior Grid Reliability Engineer reviewing a controller decision.

You will receive:
1) A GridNinja decision payload JSON containing:
   - requested deltaP (kW)
   - approved deltaP (kW)
   - blocked flag + reason code
   - plan with constraint values and per-step thermal ramp predictions
   - trace events with rule_id/status/severity/value/threshold/message

Task:
Explain WHY the action was blocked or clipped.
Decide if the dominant constraint was THERMAL, GRID/VOLTAGE, BATTERY/AGING, or POLICY/RAMP.
Cite numeric evidence (value vs threshold) and mention the most relevant rule_ids.

Output:
Return a concise Markdown "Post-Mortem Report" with:
- Verdict (Blocked/Clipped/Allowed)
- Primary constraint (Thermal vs Voltage vs Battery vs Ramp/Policy)
- Evidence (3–6 bullets with numbers + rule_id)
- What to change to make it pass next time (2–4 actions)
- Confidence (0–1)
"""


def _to_float(val: Any) -> Optional[float]:
    try:
        if val is None:
            return None
        return float(val)
    except Exception:
        return None


def _primary_str(val: Any) -> str:
    if val is None:
        return ""
    if hasattr(val, "value"):
        try:
            return str(val.value)
        except Exception:
            return str(val)
    if isinstance(val, dict) and "value" in val:
        return str(val.get("value") or "")
    return str(val)


def _cause_from_reason(reason_upper: str, primary_upper: str = "") -> str:
    if "THERMAL" in reason_upper or "THERMAL" in primary_upper:
        return "THERMAL"
    if "GRID" in reason_upper or "HEADROOM" in reason_upper or "VOLT" in reason_upper or "GRID" in primary_upper:
        return "GRID/VOLTAGE"
    if "BATTERY" in reason_upper or "AGING" in reason_upper or "BATTERY" in primary_upper:
        return "BATTERY/AGING"
    if "RAMP" in reason_upper or "POLICY" in reason_upper or "RAMP" in primary_upper:
        return "POLICY/RAMP"
    return "POLICY/RAMP"


def _severity_rank(val: Any) -> int:
    s = str(val or "").upper()
    if s == "HIGH":
        return 3
    if s == "MEDIUM":
        return 2
    if s == "LOW":
        return 1
    return 0


def _action_items(reason_upper: str, cause: str) -> List[str]:
    if "THERMAL" in reason_upper or cause == "THERMAL":
        return [
            "Increase cooling headroom or efficiency",
            "Reduce IT load or requested deltaP",
            "Slow the ramp rate or extend the horizon",
        ]
    if "GRID" in reason_upper or "HEADROOM" in reason_upper or cause == "GRID/VOLTAGE":
        return [
            "Reduce requested deltaP magnitude",
            "Increase available grid headroom or schedule off-peak",
            "Re-try after frequency/voltage stabilizes",
        ]
    if "BATTERY" in reason_upper or "AGING" in reason_upper or cause == "BATTERY/AGING":
        return [
            "Reduce throughput or deltaP magnitude",
            "Allow battery to cool before retry",
            "Schedule during lower-load periods",
        ]
    if "RAMP" in reason_upper or "POLICY" in reason_upper or cause == "POLICY/RAMP":
        return [
            "Lower ramp_rate_kw_per_s",
            "Extend horizon_s to smooth ramp",
            "Reduce requested deltaP magnitude",
        ]
    return [
        "Reduce requested deltaP magnitude",
        "Re-try during lower-load conditions",
        "Adjust ramp rate to improve stability",
    ]


def _heuristic_fallback(decision: Dict[str, Any]) -> Dict[str, Any]:
    """Deterministic post-mortem using plan + trace only."""
    plan = decision.get("plan") or {}
    blocked = bool(decision.get("blocked"))

    requested = _to_float(decision.get("requested_deltaP_kw")) or 0.0
    approved = _to_float(decision.get("approved_deltaP_kw")) or 0.0
    clipped = (abs(approved) + 1e-9) < abs(requested)

    reason = str(decision.get("reason") or plan.get("reason") or "UNKNOWN")
    primary_raw = _primary_str(plan.get("primary_constraint") or "")
    primary_upper = primary_raw.upper()
    reason_upper = reason.upper()
    cause = _cause_from_reason(reason_upper, primary_upper)

    constraint_value = _to_float(plan.get("constraint_value"))
    constraint_threshold = _to_float(plan.get("constraint_threshold"))

    # Evidence selection
    trace: List[Dict[str, Any]] = decision.get("trace") or []
    scored: List[Tuple[int, Dict[str, Any]]] = []
    for e in trace:
        status = str(e.get("status") or "").upper()
        sev = _severity_rank(e.get("severity"))
        has_vals = _to_float(e.get("value")) is not None and _to_float(e.get("threshold")) is not None
        score = 0
        if status == "BLOCKED":
            score += 4
        score += sev
        if has_vals:
            score += 2
        scored.append((score, e))

    scored.sort(key=lambda t: t[0], reverse=True)

    evidence_lines: List[str] = []
    if constraint_value is not None and constraint_threshold is not None:
        label = reason if reason != "UNKNOWN" else (primary_raw or "CONSTRAINT")
        evidence_lines.append(
            f"- **{label}**: constraint (value={constraint_value}, threshold={constraint_threshold})"
        )

    seen = set()
    for _, e in scored:
        if len(evidence_lines) >= 6:
            break
        rid = str(e.get("rule_id") or "RULE")
        msg = str(e.get("message") or "").strip()
        val = _to_float(e.get("value"))
        thr = _to_float(e.get("threshold"))
        key = (rid, val, thr, msg)
        if key in seen:
            continue
        seen.add(key)
        if val is not None and thr is not None:
            line = f"- **{rid}**: {msg} (value={val}, threshold={thr})" if msg else f"- **{rid}** (value={val}, threshold={thr})"
        else:
            line = f"- **{rid}**: {msg}" if msg else f"- **{rid}**"
        evidence_lines.append(line)

    if not evidence_lines:
        evidence_lines = ["- No high-severity trace events available."]

    verdict = "Blocked" if blocked else ("Clipped" if clipped else "Allowed")

    # Confidence scoring
    if constraint_value is not None and constraint_threshold is not None:
        confidence = 0.85
    elif any("threshold=" in ln for ln in evidence_lines):
        confidence = 0.72
    elif any("**" in ln for ln in evidence_lines):
        confidence = 0.65
    else:
        confidence = 0.55

    actions = _action_items(reason_upper, cause)

    md = f"""# Post-Mortem Report (Deterministic)

**Verdict:** {verdict}  
**Primary constraint:** {cause}  
**Reason code:** `{reason}`

## Evidence
{chr(10).join(evidence_lines)}

## How to make it pass next time
{chr(10).join([f"- {a}" for a in actions])}

**Confidence:** {confidence:.2f}
"""

    return {
        "report_markdown": md,
        "cause": cause,
        "confidence": float(confidence),
        "from_llm": False,
    }


def _shrink_decision(decision: Dict[str, Any]) -> Dict[str, Any]:
    """
    Optional: keep payload readable + cheaper.
    Keeps full trace but trims if needed.
    """
    d = dict(decision)
    trace = d.get("trace") or []
    if isinstance(trace, list) and len(trace) > 120:
        d["trace"] = trace[-120:]  # keep last 120 trace events
    return d


def explain_decision(decision: Dict[str, Any]) -> Dict[str, Any]:
    """
    Generate a Post-Mortem Report for a controller decision.
    
    Args:
        decision: The full decision payload from /decision/latest
        
    Returns:
        Dict with report_markdown, cause, confidence, from_llm
    """
    demo_mode = env_flag("DEMO_MODE", False)
    offline_mode = env_flag("OFFLINE_MODE", False) or env_flag("DEMO_OFFLINE", False)
    explainer_enabled = env_flag("EXPLAINER_ENABLED", not (demo_mode or offline_mode))
    if not explainer_enabled:
        return _heuristic_fallback(decision)

    api_key = os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")
    
    if not api_key or not GENAI_AVAILABLE:
        return _heuristic_fallback(decision)

    client = genai.Client(api_key=api_key)

    payload = _shrink_decision(decision)
    user_prompt = (
        "Analyze the following GridNinja decision payload JSON and write the Post-Mortem Report.\n\n"
        "Decision payload JSON:\n"
        f"{json.dumps(payload, indent=2)}"
    )

    try:
        resp = client.models.generate_content(
            model=DEFAULT_MODEL,
            contents=[SYSTEM_INSTRUCTIONS, user_prompt],
        )
        text = (resp.text or "").strip()
        if not text:
            return _heuristic_fallback(decision)

        # Light cause extraction from plan.reason for UI tagging
        plan = decision.get("plan") or {}
        reason = str(decision.get("reason") or plan.get("reason") or "UNKNOWN").upper()
        if "THERMAL" in reason:
            cause = "THERMAL"
        elif "GRID" in reason:
            cause = "GRID/VOLTAGE"
        elif "BATTERY" in reason:
            cause = "BATTERY/AGING"
        else:
            cause = "POLICY/RAMP"

        return {
            "report_markdown": text,
            "cause": cause,
            "confidence": 0.85,
            "from_llm": True,
        }
    except Exception:
        # Never fail the demo
        return _heuristic_fallback(decision)
