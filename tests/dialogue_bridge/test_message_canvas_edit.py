"""Ask agent on a canvas selection — the bridge's half (plan 44, Phase 4.3).

A user message may carry ``canvasEdit`` (the passage of one of the
conversation's canvas documents, and the instruction). Pinned here:

* ``MessageIn.canvasEdit`` takes the contract's shape and bounds, only on a
  user message, never with a command, and anything else is a 422 at the API;
* a start checks it with the agents service before anything commits: no such
  document is a 404, a version above the latest or a non-canonical path a
  422; a new conversation, a plain message route or a busy (queued) send
  refuses it;
* it is stored on the user message (``messages.canvas_edit``), comes back on
  ``MessageOut`` (an unreadable stored value is null, never a failed load),
  rides the run context in snake_case only when set, and a fork keeps it;
* the migration chain has one head, ``0050_message_canvas_edit``;
* plan 44 v2: ``commentId`` (the thread a comment-started edit came from) is
  a canonical UUID; the start also asks the agents service for that comment
  and refuses — 422 ``invalid_canvas_edit`` — a missing comment, a reply, a
  resolved thread or one on another document; the run context carries it as
  ``comment_id`` only when set.
"""
from __future__ import annotations

import asyncio
import json
import re
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import httpx
import pytest
from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.orm import selectinload

import utils.composer_queue as composer_queue
import utils.inference_runs as ir
import utils.inference_start as inference_start_module
from core.database import ConversationTable, MessageTable
from schema import InferenceStartPayload, MessageIn, MessageOut
from utils.canvas_edit import canvas_edit_context
from utils.conversations import clone_branch_to_conversation
from utils.inference_runs import inference_run_manager
from utils.inference_start import start_inference_flow

BRIEF = "/conversation/output/brief.md"
WHEN = "2026-11-18T10:00:00+00:00"
VERSIONS = (
    Path(__file__).resolve().parents[2] / "magenticx" / "dialogue_bridge" / "core" / "database" / "migrations" / "versions"
)


def _edit(**overrides: Any) -> dict[str, Any]:
    edit = {
        "path": BRIEF,
        "version": 4,
        "selection": "The exact selected text.",
        "headingPath": ["2. Scope", "Out of scope"],
        "instruction": "Make it shorter",
        "preset": "shorter",
        "commentId": None,
    }
    edit.update(overrides)
    return edit


def _history(path: str = BRIEF, latest: int | None = 4) -> httpx.Response:
    versions = [] if latest is None else [
        {"version": latest, "author": "user", "base_version": latest - 1 or None, "created_at": WHEN,
         "size_bytes": 10},
    ]
    return httpx.Response(200, json={"path": path, "versions": versions})


@pytest.fixture
def agent_lookup(monkeypatch, seeded_agent):
    async def agent_by_id(agent_id):
        return seeded_agent if agent_id == seeded_agent.id else None

    monkeypatch.setattr(inference_start_module, "get_agent_by_id", agent_by_id)
    monkeypatch.setattr(ir, "get_agent_by_id", agent_by_id)
    return agent_by_id


async def _answered_conversation(session_factory, user, agent) -> tuple[str, str]:
    """A conversation with one finished question and answer: ``(conversation_id, answer_id)``."""
    async with session_factory() as db:
        conversation = ConversationTable(user_id=user.id, agent_id=agent.id, agent_name=agent.name,
                                         title="t", is_private=False)
        db.add(conversation)
        await db.flush()
        question = MessageTable(conversation_id=conversation.id, sender="user", content="write a brief")
        db.add(question)
        await db.flush()
        answer = MessageTable(conversation_id=conversation.id, sender="ai", content="here it is",
                              parent_message_id=question.id, agent_id=agent.id, streaming_status="completed")
        db.add(answer)
        await db.commit()
        return conversation.id, answer.id


def _send(agent, conversation_id: str, parent_id: str, edit: dict[str, Any] | None) -> InferenceStartPayload:
    return InferenceStartPayload(
        mode="send", agentId=agent.id, conversationId=conversation_id, parentMessageId=parent_id,
        message=MessageIn(sender="user", content="Make it shorter", canvasEdit=edit),
    )


def _versions_path(user_id: str, conversation_id: str) -> str:
    return f"/users/{user_id}/conversations/{conversation_id}/documents/versions"


async def _user_message_of(session_factory, run_id: str) -> MessageTable:
    async with session_factory() as db:
        run = await db.get(MessageTable, run_id)
        return await db.get(MessageTable, run.parent_message_id, options=[selectinload(MessageTable.attachments)])


# -- the message ------------------------------------------------------------------


def test_a_user_message_takes_a_canvas_edit():
    message = MessageIn(sender="user", content="Make it shorter", canvasEdit=_edit())
    assert message.canvasEdit.model_dump() == _edit()
    assert MessageIn(sender="user", content="x", canvasEdit=_edit(headingPath=[], preset=None)).canvasEdit.preset is None


@pytest.mark.parametrize("overrides", [
    {"path": "/conversation/output/brief.txt"},
    {"path": "/conversation/input/brief.md"},
    {"path": "/conversation/output/../input/brief.md"},
    {"path": "/conversation/output/./brief.md"},
    {"path": "conversation/output/brief.md"},
    {"version": 0},
    {"selection": ""},
    {"selection": "  \n "},
    {"selection": "x" * 8001},
    {"selection": "a" + chr(0) + "b"},
    {"instruction": ""},
    {"instruction": "x" * 2001},
    {"headingPath": ["h"] * 7},
    {"headingPath": ["x" * 201]},
    {"headingPath": [""]},
    {"preset": "louder"},
    {"extra": "field"},
    {"commentId": "not-a-uuid"},
    {"commentId": "6F1C2A3B-0000-4000-8000-000000000001"},   # not the canonical (lowercase) form
    {"commentId": "6f1c2a3b000040008000000000000001"},       # not hyphenated
    {"commentId": ""},
])
def test_an_invalid_canvas_edit_is_refused(overrides):
    with pytest.raises(ValidationError):
        MessageIn(sender="user", content="x", canvasEdit=_edit(**overrides))


def test_the_limits_themselves_are_accepted():
    edit = _edit(selection="x" * 8000, instruction="y" * 2000, headingPath=["h" * 200] * 6)
    assert MessageIn(sender="user", content="x", canvasEdit=edit).canvasEdit.version == 4


def test_only_a_user_message_without_a_command_carries_one():
    with pytest.raises(ValidationError):
        MessageIn(sender="ai", content="x", canvasEdit=_edit())
    with pytest.raises(ValidationError):
        MessageIn(sender="user", content="x", canvasEdit=_edit(), command={"name": "explain"})


async def test_an_invalid_canvas_edit_is_a_422_at_the_start_route(client, seeded_user, seeded_agent, monkeypatch):
    launched: list[str] = []
    monkeypatch.setattr(inference_run_manager, "launch", launched.append)
    response = await client.post(f"/v1/inference/runs/{seeded_user.id}/start", json={
        "mode": "send", "agentId": seeded_agent.id, "conversationId": "c", "parentMessageId": "m",
        "message": {"sender": "user", "content": "x", "canvasEdit": _edit(selection="")},
    })
    assert response.status_code == 422
    assert launched == []


# -- the check before anything commits -------------------------------------------------


async def test_a_send_checks_the_document_and_stores_the_edit(
    agent_lookup, agents_service, session_factory, seeded_user, seeded_agent
):
    conversation_id, answer_id = await _answered_conversation(session_factory, seeded_user, seeded_agent)
    agents_service.on("GET", _versions_path(seeded_user.id, conversation_id), _history(latest=5))

    async with session_factory() as db:
        response = await start_inference_flow(
            db=db, user=seeded_user, payload=_send(seeded_agent, conversation_id, answer_id, _edit())
        )

    [call] = agents_service.called("GET", _versions_path(seeded_user.id, conversation_id))
    assert dict(call.url.params) == {"path": BRIEF, "limit": "1"}
    assert call.headers.get("x-internal-proxy-secret")
    user_message = await _user_message_of(session_factory, response.message.id)
    assert user_message.canvas_edit == _edit()
    assert user_message.content == "Make it shorter"
    assert MessageOut.model_validate(user_message).canvasEdit.model_dump() == _edit()


@pytest.mark.parametrize(("reply", "status_code"), [
    (_history(latest=None), 404),                                       # no such document here
    (httpx.Response(404, json={"detail": "No such document."}), 404),
    (_history(latest=3), 422),                                          # version 4 is above the latest
    (_history(path="/conversation/output/other.md"), 422),              # not the canonical path sent
    (httpx.Response(422, json={"detail": "not a document"}), 422),
    (httpx.Response(500), 502),
])
async def test_a_canvas_edit_the_conversation_cannot_hold_is_refused_and_nothing_is_stored(
    agent_lookup, agents_service, session_factory, seeded_user, seeded_agent, reply, status_code
):
    conversation_id, answer_id = await _answered_conversation(session_factory, seeded_user, seeded_agent)
    agents_service.on("GET", _versions_path(seeded_user.id, conversation_id), reply)

    async with session_factory() as db:
        with pytest.raises(HTTPException) as refused:
            await start_inference_flow(
                db=db, user=seeded_user, payload=_send(seeded_agent, conversation_id, answer_id, _edit())
            )
        await db.rollback()
    assert refused.value.status_code == status_code
    async with session_factory() as db:
        rows = (await db.execute(
            select(MessageTable).where(MessageTable.conversation_id == conversation_id)
        )).scalars().all()
    assert len(rows) == 2  # the question and the answer only


async def test_an_unreachable_agents_service_is_a_503(
    agent_lookup, agents_service, session_factory, seeded_user, seeded_agent
):
    conversation_id, answer_id = await _answered_conversation(session_factory, seeded_user, seeded_agent)

    def down(request):
        raise httpx.ConnectError("agents down", request=request)

    agents_service.on("GET", _versions_path(seeded_user.id, conversation_id), down)
    async with session_factory() as db:
        with pytest.raises(HTTPException) as refused:
            await start_inference_flow(
                db=db, user=seeded_user, payload=_send(seeded_agent, conversation_id, answer_id, _edit())
            )
    assert refused.value.status_code == 503


# -- plan 44 v2: an edit started from a comment thread -----------------------------

THREAD = "6f1c2a3b-0000-4000-8000-000000000001"


def _comment_path(user_id: str, conversation_id: str, comment_id: str = THREAD) -> str:
    return f"/users/{user_id}/conversations/{conversation_id}/documents/comments/{comment_id}"


def _comment(**overrides: Any) -> httpx.Response:
    comment = {
        "id": THREAD, "path": BRIEF, "version": 4, "parent_id": None,
        "anchor": {"quote": "The exact selected text.", "prefix": "", "suffix": ""},
        "body": "@agent make it shorter", "author": "user", "status": "open", "resolved_by": None,
        "resolution_note": None, "created_at": WHEN, "updated_at": WHEN,
    }
    comment.update(overrides)
    return httpx.Response(200, json=comment)


async def test_a_comment_started_edit_checks_the_thread_and_stores_its_id(
    agent_lookup, agents_service, session_factory, seeded_user, seeded_agent
):
    conversation_id, answer_id = await _answered_conversation(session_factory, seeded_user, seeded_agent)
    agents_service.on("GET", _versions_path(seeded_user.id, conversation_id), _history(latest=4))
    agents_service.on("GET", _comment_path(seeded_user.id, conversation_id), _comment())

    async with session_factory() as db:
        response = await start_inference_flow(
            db=db, user=seeded_user,
            payload=_send(seeded_agent, conversation_id, answer_id, _edit(commentId=THREAD, preset=None)),
        )

    [call] = agents_service.called("GET", _comment_path(seeded_user.id, conversation_id))
    assert call.headers.get("x-internal-proxy-secret")
    user_message = await _user_message_of(session_factory, response.message.id)
    assert user_message.canvas_edit["commentId"] == THREAD
    assert MessageOut.model_validate(user_message).canvasEdit.commentId == THREAD


@pytest.mark.parametrize("reply", [
    httpx.Response(404, json={"detail": "No such document or comment."}),   # not in this conversation
    _comment(parent_id="6f1c2a3b-0000-4000-8000-000000000002"),           # a reply, not a thread
    _comment(status="resolved", resolved_by="user"),                        # not open
    _comment(path="/conversation/output/other.md"),                         # another document
])
async def test_a_comment_started_edit_on_a_thread_that_is_not_open_here_is_a_422(
    agent_lookup, agents_service, session_factory, seeded_user, seeded_agent, reply
):
    conversation_id, answer_id = await _answered_conversation(session_factory, seeded_user, seeded_agent)
    agents_service.on("GET", _versions_path(seeded_user.id, conversation_id), _history(latest=4))
    agents_service.on("GET", _comment_path(seeded_user.id, conversation_id), reply)

    async with session_factory() as db:
        with pytest.raises(HTTPException) as refused:
            await start_inference_flow(
                db=db, user=seeded_user,
                payload=_send(seeded_agent, conversation_id, answer_id, _edit(commentId=THREAD)),
            )
        await db.rollback()
    assert refused.value.status_code == 422
    assert refused.value.detail == {"code": "invalid_canvas_edit",
                                    "message": "That comment thread is not open on this document."}
    async with session_factory() as db:
        rows = (await db.execute(
            select(MessageTable).where(MessageTable.conversation_id == conversation_id)
        )).scalars().all()
    assert len(rows) == 2  # the question and the answer only


async def test_a_comment_check_the_agents_service_cannot_answer_is_a_503(
    agent_lookup, agents_service, session_factory, seeded_user, seeded_agent
):
    conversation_id, answer_id = await _answered_conversation(session_factory, seeded_user, seeded_agent)
    agents_service.on("GET", _versions_path(seeded_user.id, conversation_id), _history(latest=4))

    def down(request):
        raise httpx.ConnectError("agents down", request=request)

    agents_service.on("GET", _comment_path(seeded_user.id, conversation_id), down)
    async with session_factory() as db:
        with pytest.raises(HTTPException) as refused:
            await start_inference_flow(
                db=db, user=seeded_user,
                payload=_send(seeded_agent, conversation_id, answer_id, _edit(commentId=THREAD)),
            )
    assert refused.value.status_code == 503


async def test_a_plain_ask_agent_edit_never_asks_for_a_comment(
    agent_lookup, agents_service, session_factory, seeded_user, seeded_agent
):
    conversation_id, answer_id = await _answered_conversation(session_factory, seeded_user, seeded_agent)
    agents_service.on("GET", _versions_path(seeded_user.id, conversation_id), _history(latest=4))

    async with session_factory() as db:
        await start_inference_flow(
            db=db, user=seeded_user, payload=_send(seeded_agent, conversation_id, answer_id, _edit())
        )

    assert [c.url.path for c in agents_service.calls] == [_versions_path(seeded_user.id, conversation_id)]


async def test_a_new_conversation_cannot_carry_a_canvas_edit(agent_lookup, agents_service, session_factory,
                                                             seeded_user, seeded_agent):
    payload = InferenceStartPayload(
        mode="new", agentId=seeded_agent.id, title="t",
        message=MessageIn(sender="user", content="Make it shorter", canvasEdit=_edit()),
    )
    async with session_factory() as db:
        with pytest.raises(HTTPException) as refused:
            await start_inference_flow(db=db, user=seeded_user, payload=payload)
    assert refused.value.status_code == 422
    assert agents_service.calls == []


async def test_the_plain_message_route_refuses_a_canvas_edit(client, session_factory, seeded_user, seeded_agent):
    conversation_id, answer_id = await _answered_conversation(session_factory, seeded_user, seeded_agent)
    response = await client.post(f"/v1/messages/{seeded_user.id}/{conversation_id}", json={
        "sender": "user", "content": "x", "parentMessageId": answer_id, "canvasEdit": _edit(),
    })
    assert response.status_code == 422


async def test_a_busy_conversation_does_not_queue_a_canvas_edit(
    agent_lookup, monkeypatch, session_factory, seeded_user, seeded_agent
):
    monkeypatch.setattr(composer_queue, "get_agent_by_id", agent_lookup)
    conversation_id, answer_id = await _answered_conversation(session_factory, seeded_user, seeded_agent)
    async with session_factory() as db:
        db.add(MessageTable(conversation_id=conversation_id, sender="ai", content="", parent_message_id=answer_id,
                            streaming_status="running", streaming_started_at=ir._now()))
        await db.commit()
    payload = _send(seeded_agent, conversation_id, answer_id, _edit())
    payload.queue_if_busy = True

    async with session_factory() as db:
        with pytest.raises(HTTPException) as refused:
            await composer_queue.queue_if_busy(db, seeded_user, payload)
    assert refused.value.status_code == 409
    async with session_factory() as db:
        assert (await db.get(ConversationTable, conversation_id)).queued_message is None


# -- stored, shown, forked ------------------------------------------------------------


@pytest.mark.parametrize("stored", [
    {"path": BRIEF},                                   # missing fields
    {**_edit(), "version": "four"},
    "not an object",
    [],
    {},
])
def test_an_unreadable_stored_value_reads_back_as_null(stored):
    row = SimpleNamespace(id="m", parent_message_id=None, content="x", sender="user", liked=None, agent_id=None,
                          agent_name=None, created_at="2026-11-18T10:00:00", updated_at="2026-11-18T10:00:00",
                          attachments=[], canvas_edit=stored)
    assert MessageOut.model_validate(row).canvasEdit is None


def test_a_stored_value_with_an_unknown_key_reads_back_without_it():
    row = SimpleNamespace(id="m", parent_message_id=None, content="x", sender="user", liked=None, agent_id=None,
                          agent_name=None, created_at="2026-11-18T10:00:00", updated_at="2026-11-18T10:00:00",
                          attachments=[], canvas_edit={**_edit(), "later": 1})
    assert MessageOut.model_validate(row).canvasEdit.model_dump() == _edit()


def test_every_other_message_has_null():
    row = SimpleNamespace(id="m", parent_message_id=None, content="x", sender="ai", liked=None, agent_id=None,
                          agent_name=None, created_at="2026-11-18T10:00:00", updated_at="2026-11-18T10:00:00",
                          attachments=[], canvas_edit=None)
    assert MessageOut.model_validate(row).model_dump()["canvasEdit"] is None


async def test_a_fork_keeps_the_canvas_edit(session_factory, seeded_user, seeded_agent):
    async with session_factory() as db:
        conversation = ConversationTable(user_id=seeded_user.id, agent_id=seeded_agent.id,
                                         agent_name=seeded_agent.name, title="t", is_private=False)
        db.add(conversation)
        await db.flush()
        question = MessageTable(conversation_id=conversation.id, sender="user", content="Make it shorter",
                                canvas_edit=_edit())
        db.add(question)
        await db.flush()
        answer = MessageTable(conversation_id=conversation.id, sender="ai", content="a",
                              parent_message_id=question.id)
        db.add(answer)
        await db.commit()
        ids = [question.id, answer.id]
    async with session_factory() as db:
        source = await db.get(ConversationTable, conversation.id)
        loaded = {
            m.id: m for m in (await db.execute(
                select(MessageTable).where(MessageTable.id.in_(ids)).options(selectinload(MessageTable.attachments))
            )).scalars().all()
        }
        forked = await clone_branch_to_conversation(
            db=db, source_conv=source, branch=[loaded[i] for i in ids], forked_message_id=ids[-1]
        )
        await db.commit()
        forked_id = forked.id
    async with session_factory() as db:
        rows = (await db.execute(
            select(MessageTable).where(MessageTable.conversation_id == forked_id, MessageTable.sender == "user")
        )).scalars().all()
    assert [row.canvas_edit for row in rows] == [_edit()]


# -- the run context ----------------------------------------------------------------


def test_the_run_context_carries_it_in_snake_case():
    assert canvas_edit_context(SimpleNamespace(canvas_edit=_edit())) == {"canvas_edit": {
        "path": BRIEF, "version": 4, "selection": "The exact selected text.",
        "heading_path": ["2. Scope", "Out of scope"], "instruction": "Make it shorter", "preset": "shorter",
    }}


def test_the_run_context_carries_the_comment_id_only_when_set():
    with_thread = canvas_edit_context(SimpleNamespace(canvas_edit=_edit(commentId=THREAD)))
    assert with_thread["canvas_edit"]["comment_id"] == THREAD
    assert "comment_id" not in canvas_edit_context(SimpleNamespace(canvas_edit=_edit()))["canvas_edit"]
    # A stored value from before v2 (no key at all) reads back the same way.
    stored = {k: v for k, v in _edit().items() if k != "commentId"}
    assert "comment_id" not in canvas_edit_context(SimpleNamespace(canvas_edit=stored))["canvas_edit"]


def test_the_run_context_has_no_key_without_one():
    assert canvas_edit_context(None) == {}
    assert canvas_edit_context(SimpleNamespace(canvas_edit=None)) == {}
    assert canvas_edit_context(SimpleNamespace()) == {}
    # A stored value that no longer fits is dropped, not forwarded.
    assert canvas_edit_context(SimpleNamespace(canvas_edit={"path": BRIEF})) == {}


class _Upstream:
    """The agents service at the stream seam, recording what each run sends."""

    def __init__(self) -> None:
        self.payloads: list[dict[str, Any]] = []

    async def stream(self, manager, run_id, run_meta, runtime, agent_url, request_payload) -> str:
        self.payloads.append(request_payload)
        return "completed"


@pytest.fixture
def upstream(monkeypatch, session_factory):
    fake = _Upstream()

    async def _do_stream(self, *args):
        return await fake.stream(self, *args)

    monkeypatch.setattr(ir.InferenceRunManager, "_do_stream", _do_stream)
    monkeypatch.setattr(ir, "SessionLocal", session_factory)
    return fake


async def test_the_run_config_carries_the_canvas_edit(
    agent_lookup, agents_service, upstream, session_factory, seeded_user, seeded_agent
):
    conversation_id, answer_id = await _answered_conversation(session_factory, seeded_user, seeded_agent)
    agents_service.on("GET", _versions_path(seeded_user.id, conversation_id), _history(latest=4))
    agents_service.on("POST", f"/users/{seeded_user.id}/conversations/{conversation_id}/documents/capture",
                      httpx.Response(200, json={"captured": []}))
    async with session_factory() as db:
        response = await start_inference_flow(
            db=db, user=seeded_user, payload=_send(seeded_agent, conversation_id, answer_id, _edit())
        )
    ir.InferenceRunManager.launch(inference_run_manager, response.message.id)
    task = inference_run_manager._tasks.get(response.message.id)
    if task is not None:
        await asyncio.wait_for(task, timeout=5)

    assert len(upstream.payloads) == 1
    context = upstream.payloads[0]["config"]["context"]
    assert context["canvas_edit"]["selection"] == "The exact selected text."
    assert context["canvas_edit"]["heading_path"] == ["2. Scope", "Out of scope"]
    # The bubble's text is the instruction; the passage rides the context only.
    assert json.dumps(upstream.payloads[0]["messages"]).count("The exact selected text.") == 0


# -- the migration ------------------------------------------------------------------


def test_the_canvas_edit_migration_is_the_single_head():
    revisions: dict[str, str | None] = {}
    for path in VERSIONS.glob("*.py"):
        text = path.read_text(encoding="utf-8")
        revision = re.search(r'^revision(?:\s*:\s*str)?\s*=\s*["\']([^"\']+)["\']', text, re.M).group(1)
        down = re.search(r'^down_revision[^=]*=\s*(?:["\']([^"\']+)["\']|None)', text, re.M)
        revisions[revision] = down.group(1) if down else None
    parents = {down for down in revisions.values() if down}
    heads = [rev for rev in revisions if rev not in parents]
    # One head, with 0050 on its chain (a later migration, e.g. 0051's PDF
    # previews, may sit on top of it).
    assert len(heads) == 1
    chain, rev = [], heads[0]
    while rev:
        chain.append(rev)
        rev = revisions.get(rev)
    assert "0050_message_canvas_edit" in chain
    assert revisions["0050_message_canvas_edit"] == "0049_attachment_source_path"
