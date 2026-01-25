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
from typing import Any, Dict, List

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


def _heuristic_fallback(decision: Dict[str, Any]) -> Dict[str, Any]:
    """Always-works explanation if no API key is configured."""
    plan = decision.get("plan") or {}
    blocked = bool(decision.get("blocked"))
    reason = str(decision.get("reason") or plan.get("reason") or "UNKNOWN")
    primary = str(plan.get("primary_constraint") or "UNKNOWN")

    # Determine cause bucket quickly
    reason_upper = reason.upper()
    if "THERMAL" in reason_upper:
        cause = "THERMAL"
    elif "GRID" in reason_upper or primary.upper() == "GRID":
        cause = "GRID/VOLTAGE"
    elif "BATTERY" in reason_upper:
        cause = "BATTERY/AGING"
    else:
        cause = "POLICY/RAMP"

    # Pull strongest trace evidence
    trace: List[Dict[str, Any]] = decision.get("trace") or []
    bad = [e for e in trace if str(e.get("status")) == "BLOCKED" or str(e.get("severity")) == "HIGH"]
    bad = bad[-6:]  # keep last few

    evidence_lines = []
    for e in bad:
        rid = e.get("rule_id", "RULE")
        msg = e.get("message", "")
        val = e.get("value", None)
        thr = e.get("threshold", None)
        if val is not None and thr is not None:
            evidence_lines.append(f"- **{rid}**: {msg} (value={val}, threshold={thr})")
        else:
            evidence_lines.append(f"- **{rid}**: {msg}")

    verdict = "Blocked" if blocked else "Allowed/Clipped"

    md = f"""# Post-Mortem Report (Fallback)

**Verdict:** {verdict}  
**Primary constraint:** {cause}  
**Reason code:** `{reason}`

## Evidence
{chr(10).join(evidence_lines) if evidence_lines else "- No high-severity trace events available."}

## How to make it pass next time
- Reduce requested deltaP or ramp more gradually
- Increase cooling headroom / reduce thermal load
- Increase available grid headroom (if voltage/line constraints)
- Re-try during lower-carbon or lower-load window

**Confidence:** 0.55
"""

    return {
        "report_markdown": md,
        "cause": cause,
        "confidence": 0.55,
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
