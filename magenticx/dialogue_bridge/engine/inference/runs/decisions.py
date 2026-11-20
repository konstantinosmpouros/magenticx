"""Human-in-the-loop decisions of a paused run: who can answer, the resolved
marker written to the event log, and the agents-service ``/resume`` shape.
"""

from typing import Any
from core.database import (
    MessageTable,
)
from core.logging import get_logger

logger = get_logger(__name__)


def run_is_interactive(run: MessageTable) -> bool:
    """Whether a person is there to answer this run's questions (``ask_user``).

    A chat turn is; a scheduled task's run is not — nobody would ever resume
    it, so the agents service leaves the tool out."""
    return run.scheduled_task_id is None


def hitl_resolved_value(resume_payload: dict[str, Any], decision: str) -> dict[str, Any]:
    """The ``BRIDGE_HITL_RESOLVED`` marker's value for one resume.

    Persisted in the event log so a reloaded client knows the pause was
    resolved, and how. An ``ask_user`` reply also carries the user's
    ``answers`` (``value.answers`` of the resume), so the panel can show what
    was answered after a reload.
    """
    marker: dict[str, Any] = {
        "interrupt_id": resume_payload.get("interrupt_id"),
        "decision": decision,
        "reason": resume_payload.get("reason"),
        "decisions": resume_payload.get("decisions"),
    }
    value = resume_payload.get("value")
    if isinstance(value, dict) and isinstance(value.get("answers"), list):
        marker["answers"] = value["answers"]
    return marker


def overall_hitl_decision(resume_payload: dict[str, Any]) -> str:
    """The scalar decision of one resume for its resolved marker.

    ``decisions`` (per-action list) drives the UI's per-tool approval chips for
    a batched interrupt; the scalar (approve if any action was approved) keeps
    the single-action reducer path and legacy clients working.
    """
    decisions = resume_payload.get("decisions")
    if decisions:
        return "approve" if any(d.get("decision") == "approve" for d in decisions) else "reject"
    return resume_payload.get("decision", "approve")


def _agent_resume_item(resume_payload: dict[str, Any]) -> dict[str, Any]:
    """One decision in the agents-service ``/resume`` shape."""
    return {
        "decision": resume_payload.get("decision", "approve"),
        "reason": resume_payload.get("reason"),
        "value": resume_payload.get("value"),
        "interrupt_id": resume_payload.get("interrupt_id"),
        "decisions": resume_payload.get("decisions"),
    }
