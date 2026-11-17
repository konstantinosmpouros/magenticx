"""Parallel approvals: several interrupts pending at once, each answered by id.

A run can pause on several approval gates at once (parallel tool calls), so
the checkpoint holds several interrupts. A decision must reach the interrupt it
was made for — whether they are answered together (one resume,
``Command(resume={interrupt_id: value, ...})``), in part, or one at a time in
any order. A bare resume value would go to whichever paused task read it first.

These tests check the /resume route's request shapes, through the route's own
:func:`utils.hitl_resume.build_resume_command`.
"""
from __future__ import annotations

from typing import ClassVar

from test_main_skill_routes import _FakeInterrupt, _FakeResumeAgent, _resume_env


def _approve(interrupt_id: str) -> dict:
    return {"interrupt_id": interrupt_id, "decision": "approve"}


def _reject(interrupt_id: str, reason: str) -> dict:
    return {"interrupt_id": interrupt_id, "decision": "reject", "reason": reason}


# ---------------------------------------------------------------------------
# The /resume route
# ---------------------------------------------------------------------------
_A, _B, _C = "a" * 32, "b" * 32, "c" * 32


class _ThreeGatesAgent(_FakeResumeAgent):
    interrupts: ClassVar[list] = [_FakeInterrupt(_A), _FakeInterrupt(_B), _FakeInterrupt(_C)]


def _resume(client, internal_headers, **body):
    return client.post(
        "/agents/omni/resume",
        headers=internal_headers,
        json={"config": {"run_config": {"configurable": {}}}, "thread_id": "t-1", "decision": "approve", **body},
    )


async def test_route_applies_a_batch_keyed_by_interrupt(client, agents_service, internal_headers, monkeypatch):
    _resume_env(agents_service, monkeypatch, agent_cls=_ThreeGatesAgent)
    _ThreeGatesAgent.captured_command = {}
    response = await _resume(
        client, internal_headers, interrupt_id=_C,
        resumes=[_approve(_C), _reject(_A, "no")],
    )
    assert response.status_code == 200
    assert _ThreeGatesAgent.captured_command["command"].resume == {
        _C: {"decisions": [{"type": "approve"}]},
        _A: {"decisions": [{"type": "reject", "message": "no"}]},
    }


async def test_route_targets_the_named_interrupt_not_the_first(client, agents_service, internal_headers, monkeypatch):
    _resume_env(agents_service, monkeypatch, agent_cls=_ThreeGatesAgent)
    _ThreeGatesAgent.captured_command = {}
    response = await _resume(client, internal_headers, interrupt_id=_B, decision="reject", reason="later")
    assert response.status_code == 200
    assert _ThreeGatesAgent.captured_command["command"].resume == {
        _B: {"decisions": [{"type": "reject", "message": "later"}]},
    }


async def test_route_refuses_a_batch_with_an_interrupt_that_is_not_pending(
    client, agents_service, internal_headers, monkeypatch,
):
    _resume_env(agents_service, monkeypatch, agent_cls=_ThreeGatesAgent)
    _ThreeGatesAgent.captured_command = {}
    response = await _resume(client, internal_headers, resumes=[_approve(_A), _approve("d" * 32)])
    assert response.status_code == 409
    assert _ThreeGatesAgent.captured_command == {}
    # Listed through the service's error handler, so the bridge can recover.
    detail = response.json()["detail"]
    assert detail["stale_interrupt_ids"] == ["d" * 32]
    assert detail["pending_interrupt_ids"] == [_A, _B, _C]


async def test_route_refuses_a_batch_answering_one_interrupt_twice(
    client, agents_service, internal_headers, monkeypatch,
):
    _resume_env(agents_service, monkeypatch, agent_cls=_ThreeGatesAgent)
    _ThreeGatesAgent.captured_command = {}
    response = await _resume(client, internal_headers, resumes=[_approve(_A), _reject(_A, "no")])
    assert response.status_code == 422
    assert _ThreeGatesAgent.captured_command == {}


class _OneGateAgent(_FakeResumeAgent):
    interrupts: ClassVar[list] = [_FakeInterrupt(_A)]


async def test_route_keys_a_single_pending_interrupt_too(client, agents_service, internal_headers, monkeypatch):
    # Never a bare value for a real interrupt id: a bare value is stored as a
    # run-wide answer a nested sub-agent's later gate could read as its own.
    _resume_env(agents_service, monkeypatch, agent_cls=_OneGateAgent)
    _OneGateAgent.captured_command = {}
    response = await _resume(client, internal_headers, interrupt_id=_A)
    assert response.status_code == 200
    assert _OneGateAgent.captured_command["command"].resume == {_A: {"decisions": [{"type": "approve"}]}}


async def test_route_keeps_a_bare_value_for_an_id_langgraph_would_not_key(
    client, agents_service, internal_headers, monkeypatch,
):
    # Not an id LangGraph reads as a resume map: the bare value it can apply.
    _resume_env(agents_service, monkeypatch)
    _FakeResumeAgent.captured_command = {}
    response = await _resume(client, internal_headers, interrupt_id="int-1")
    assert response.status_code == 200
    assert _FakeResumeAgent.captured_command["command"].resume == {"decisions": [{"type": "approve"}]}
