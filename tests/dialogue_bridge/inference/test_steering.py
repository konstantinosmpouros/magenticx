"""Steering: a run reads the message the user sent while it worked (SSE plan, phase 5).

Pinned: queuing a plain message behind a run rings that run's doorbell
(``run:{id}:steer``), after the commit; the internal claim hands the message to
that run exactly once — emptying the slot, clearing the doorbell and telling
the composer — and only when it was queued behind *this* run, is plain text,
is for the agent that runs and the run is still active; anything else stays in
the slot for the run-end send. Cancelling or the run-end send clears the
doorbell; the claim is internal-only and owner-checked.
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from typing import Any

import pytest
from sqlalchemy import select
from sqlalchemy.orm import selectinload

import engine.conversations.compaction as compaction
import engine.inference.composer_queue as composer_queue
import engine.inference.start as inference_start
from core.database import ConversationTable, MessageTable, UserTable
from core.settings import settings
from engine.conversations.search import search_workspace_data
from engine.inference.channel import channel_key, conversation_channel
from engine.inference.history import serialise_message_with_images_for_agent, stacked_user_turn, with_interjections
from engine.inference.steering import carry_interjections, interjections_by_answer, steer_doorbell, steerable

pytestmark = pytest.mark.timeout(30)


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


@pytest.fixture(autouse=True)
def _wire(monkeypatch, session_factory, seeded_agent):
    """The queue's own sessions on the test database; the agent lookup stubbed."""
    monkeypatch.setattr(composer_queue, "SessionLocal", session_factory, raising=False)

    async def get_agent(_agent_id):
        return seeded_agent

    for module in (composer_queue, inference_start):
        monkeypatch.setattr(module, "get_agent_by_id", get_agent)


@pytest.fixture
def internal_headers():
    """What the agents service sends: the internal service secret."""
    return {settings.proxy.header_name: settings.proxy.internal_secret.get_secret_value()}


async def _busy_conversation(session_factory, user, agent, *, run_agent_id: Any = "same") -> dict[str, str]:
    """A conversation with one user message and a running answer to it."""
    async with session_factory() as s:
        conv = ConversationTable(user_id=user.id, agent_id=agent.id, agent_name=agent.name, title="steer",
                                 is_private=False, is_archived=False)
        s.add(conv)
        await s.flush()
        question = MessageTable(conversation_id=conv.id, sender="user", content="research X",
                                created_at=_now() - timedelta(minutes=2))
        s.add(question)
        await s.flush()
        run = MessageTable(
            conversation_id=conv.id, sender="ai", parent_message_id=question.id,
            agent_id=agent.id if run_agent_id == "same" else run_agent_id, agent_name=agent.name,
            streaming_status="running", streaming_started_at=_now(), checkpoint_thread_id="T",
            created_at=_now() - timedelta(minutes=1),
        )
        s.add(run)
        await s.commit()
        return {"conversation_id": conv.id, "question": question.id, "run": run.id}


async def _queue(session_factory, conversation_id: str, run_id: str, agent_id: str, **over: Any) -> None:
    async with session_factory() as s:
        conv = await s.get(ConversationTable, conversation_id)
        conv.queued_messages = [{
            "id": "q1", "content": "focus on Y instead", "command": None, "agent_id": agent_id,
            "queued_at": _now().isoformat(), "after_run_id": run_id, **over,
        }]
        await s.commit()


async def _slot(session_factory, conversation_id: str):
    async with session_factory() as s:
        return (await s.get(ConversationTable, conversation_id)).queued_messages


async def _channel(conversation_id: str) -> list[dict[str, Any]]:
    entries = await conversation_channel._client.xrange(channel_key(conversation_id))
    return [json.loads(fields["payload"]) for _id, fields in entries]


def _claim_url(conversation_id: str) -> str:
    return f"/v1/internal/conversations/{conversation_id}/interjection/claim"


# ---------------------------------------------------------------------------
# Queuing rings the doorbell
# ---------------------------------------------------------------------------
async def test_a_plain_message_queued_behind_a_run_rings_its_doorbell(
    client, session_factory, seeded_user, seeded_agent
):
    ids = await _busy_conversation(session_factory, seeded_user, seeded_agent)

    queued = await client.post(f"/v1/inference/runs/{seeded_user.id}/start", json={
        "mode": "send", "agentId": seeded_agent.id, "conversationId": ids["conversation_id"],
        "parentMessageId": ids["question"], "queue_if_busy": True,
        "message": {"sender": "user", "content": "focus on Y instead"},
    })

    assert queued.status_code == 202
    assert await steer_doorbell.is_rung(ids["run"])


async def test_only_plain_text_for_the_running_agent_is_steerable(session_factory, seeded_user, seeded_agent):
    ids = await _busy_conversation(session_factory, seeded_user, seeded_agent)
    async with session_factory() as s:
        assert await steerable(s, ids["run"], agent_id=seeded_agent.id, has_command=False)
        # A slash command is a turn of its own; another agent's message waits for the end.
        assert not await steerable(s, ids["run"], agent_id=seeded_agent.id, has_command=True)
        assert not await steerable(s, ids["run"], agent_id="another-agent", has_command=False)


# ---------------------------------------------------------------------------
# The claim
# ---------------------------------------------------------------------------
async def test_the_run_claims_the_message_exactly_once(
    client, session_factory, seeded_user, seeded_agent, internal_headers
):
    ids = await _busy_conversation(session_factory, seeded_user, seeded_agent)
    await _queue(session_factory, ids["conversation_id"], ids["run"], seeded_agent.id)
    await steer_doorbell.ring(ids["run"])
    body = {"user_id": seeded_user.id, "run_id": ids["run"]}

    first = await client.post(_claim_url(ids["conversation_id"]), json=body, headers=internal_headers)

    assert first.status_code == 200
    [claimed] = first.json()["messages"]
    assert claimed["content"] == "focus on Y instead"
    assert claimed["queued_at"]
    assert await _slot(session_factory, ids["conversation_id"]) is None
    assert not await steer_doorbell.is_rung(ids["run"])
    # The composer's chip goes away: the message now belongs to the run.
    assert (await _channel(ids["conversation_id"]))[-1] == {"type": "queue", "queued_messages": []}

    again = await client.post(_claim_url(ids["conversation_id"]), json=body, headers=internal_headers)
    assert again.status_code == 204


@pytest.mark.parametrize(
    "case",
    ["another_run", "a_command", "run_finished", "another_agent"],
)
async def test_what_the_run_may_not_read_stays_for_the_run_end(
    case, client, session_factory, seeded_user, seeded_agent, internal_headers
):
    ids = await _busy_conversation(
        session_factory, seeded_user, seeded_agent,
        run_agent_id=None if case == "another_agent" else "same",
    )
    over: dict[str, Any] = {}
    if case == "another_run":
        over["after_run_id"] = "some-other-run"
    if case == "a_command":
        over["command"] = {"name": "review", "args": ""}
    await _queue(session_factory, ids["conversation_id"], ids["run"], seeded_agent.id, **over)
    if case == "run_finished":
        async with session_factory() as s:
            (await s.get(MessageTable, ids["run"])).streaming_status = "completed"
            await s.commit()
    await steer_doorbell.ring(ids["run"])

    response = await client.post(
        _claim_url(ids["conversation_id"]),
        json={"user_id": seeded_user.id, "run_id": ids["run"]},
        headers=internal_headers,
    )

    assert response.status_code == 204
    assert (await _slot(session_factory, ids["conversation_id"]))[0]["content"] == "focus on Y instead"
    # A doorbell with nothing behind it is cleared, so the run stops asking.
    assert not await steer_doorbell.is_rung(ids["run"])


async def test_the_claim_is_internal_and_owner_checked(
    client, session_factory, seeded_user, seeded_agent, internal_headers
):
    ids = await _busy_conversation(session_factory, seeded_user, seeded_agent)
    await _queue(session_factory, ids["conversation_id"], ids["run"], seeded_agent.id)
    url = _claim_url(ids["conversation_id"])

    assert (await client.post(url, json={"user_id": seeded_user.id, "run_id": ids["run"]})).status_code == 403
    someone_else = await client.post(
        url, json={"user_id": "someone-else", "run_id": ids["run"]}, headers=internal_headers
    )
    assert someone_else.status_code == 404
    unknown_field = await client.post(
        url, json={"user_id": seeded_user.id, "run_id": ids["run"], "extra": 1}, headers=internal_headers
    )
    assert unknown_field.status_code == 422
    assert (await _slot(session_factory, ids["conversation_id"])) is not None


# ---------------------------------------------------------------------------
# The other ways out clear the doorbell
# ---------------------------------------------------------------------------
async def test_cancelling_the_queued_message_clears_the_doorbell(
    client, session_factory, seeded_user, seeded_agent
):
    ids = await _busy_conversation(session_factory, seeded_user, seeded_agent)
    await _queue(session_factory, ids["conversation_id"], ids["run"], seeded_agent.id)
    await steer_doorbell.ring(ids["run"])

    cancel = await client.delete(f"/v1/conversations/{seeded_user.id}/{ids['conversation_id']}/queued-messages/q1")

    assert cancel.status_code == 204
    assert not await steer_doorbell.is_rung(ids["run"])


async def test_the_run_end_send_clears_the_doorbell(session_factory, seeded_user, seeded_agent, monkeypatch):
    ids = await _busy_conversation(session_factory, seeded_user, seeded_agent)
    await _queue(session_factory, ids["conversation_id"], ids["run"], seeded_agent.id)
    await steer_doorbell.ring(ids["run"])

    async with session_factory() as s:
        taken = await composer_queue._claim_all(s, ids["conversation_id"])

    assert taken is not None and taken[1][0]["content"] == "focus on Y instead"
    assert not await steer_doorbell.is_rung(ids["run"])


# ---------------------------------------------------------------------------
# The claimed message is kept as its own message
# ---------------------------------------------------------------------------
async def _claim(client, ids, user, headers):
    return await client.post(
        _claim_url(ids["conversation_id"]), json={"user_id": user.id, "run_id": ids["run"]}, headers=headers
    )


async def test_the_claim_saves_it_as_a_message_under_its_answer(
    client, session_factory, seeded_user, seeded_agent, internal_headers
):
    ids = await _busy_conversation(session_factory, seeded_user, seeded_agent)
    await _queue(session_factory, ids["conversation_id"], ids["run"], seeded_agent.id)
    assert (await _claim(client, ids, seeded_user, internal_headers)).status_code == 200

    async with session_factory() as s:
        rows = (await s.execute(
            select(MessageTable).where(MessageTable.kind == "interjection")
        )).scalars().all()
    assert [(r.sender, r.parent_message_id, r.content) for r in rows] == [
        ("user", ids["run"], "focus on Y instead"),
    ]


async def test_it_stays_out_of_the_branch_tree(
    client, session_factory, seeded_user, seeded_agent, internal_headers
):
    ids = await _busy_conversation(session_factory, seeded_user, seeded_agent)
    await _queue(session_factory, ids["conversation_id"], ids["run"], seeded_agent.id)
    await _claim(client, ids, seeded_user, internal_headers)

    detail = (await client.get(f"/v1/conversations/{seeded_user.id}/{ids['conversation_id']}")).json()
    assert [m["id"] for m in detail["messages"]] == [ids["question"], ids["run"]]
    async with session_factory() as s:
        # The newest message is not the leaf a queued send continues.
        (await s.get(MessageTable, ids["run"])).streaming_status = "completed"
        await s.commit()
        assert await composer_queue._parent_for(s, ids["conversation_id"], None) == ids["run"]
        # Nothing was sent *after* the answer: it can still be compacted.
        assert not await compaction._has_children(s, ids["run"])


async def test_search_finds_it(client, session_factory, seeded_user, seeded_agent, internal_headers):
    ids = await _busy_conversation(session_factory, seeded_user, seeded_agent)
    await _queue(session_factory, ids["conversation_id"], ids["run"], seeded_agent.id)
    await _claim(client, ids, seeded_user, internal_headers)

    async with session_factory() as s:
        user = await s.get(UserTable, seeded_user.id)
        found = await search_workspace_data(db=s, current_user=user, query="focus on Y", limit=10)

    assert [(r.kind, r.conversationId, r.subtitle) for r in found if r.kind == "message"] == [
        ("message", ids["conversation_id"], "You message"),
    ]


async def test_a_rebuilt_history_puts_it_before_the_answer_that_read_it(
    client, session_factory, seeded_user, seeded_agent, internal_headers
):
    ids = await _busy_conversation(session_factory, seeded_user, seeded_agent)
    await _queue(session_factory, ids["conversation_id"], ids["run"], seeded_agent.id)
    await _claim(client, ids, seeded_user, internal_headers)
    async with session_factory() as s:
        loaded = (await s.execute(
            select(MessageTable).options(selectinload(MessageTable.attachments))
            .where(MessageTable.id.in_([ids["question"], ids["run"]]))
        )).scalars().all()
        question = next(m for m in loaded if m.id == ids["question"])
        answer = next(m for m in loaded if m.id == ids["run"])
        answer.content = "Y it is."
        path = [question, answer]
        serialised = [serialise_message_with_images_for_agent(m) for m in path]
        by_answer = await interjections_by_answer(s, [ids["run"]])

    history = with_interjections(path, serialised, by_answer)

    assert [(h["role"], h["content"]) for h in history] == [
        ("user", "research X"), ("user", "focus on Y instead"), ("ai", "Y it is."),
    ]


async def test_a_retry_carries_it_to_the_new_answer(
    client, session_factory, seeded_user, seeded_agent, internal_headers
):
    ids = await _busy_conversation(session_factory, seeded_user, seeded_agent)
    await _queue(session_factory, ids["conversation_id"], ids["run"], seeded_agent.id)
    await _claim(client, ids, seeded_user, internal_headers)
    async with session_factory() as s:
        retry = MessageTable(conversation_id=ids["conversation_id"], sender="ai", parent_message_id=ids["question"])
        s.add(retry)
        await s.flush()
        assert await carry_interjections(s, from_answer_id=ids["run"], to_answer_id=retry.id) == 1
        await s.commit()
        carried = await interjections_by_answer(s, [retry.id])

    assert [r.content for r in carried[retry.id]] == ["focus on Y instead"]


# ---------------------------------------------------------------------------
# Several queued messages
# ---------------------------------------------------------------------------
def _item(item_id: str, content: str, agent_id: str, run_id: str, **over: Any) -> dict[str, Any]:
    return {"id": item_id, "content": content, "command": None, "agent_id": agent_id,
            "queued_at": _now().isoformat(), "after_run_id": run_id, **over}


async def _set_queue(session_factory, conversation_id: str, items: list[dict[str, Any]]) -> None:
    async with session_factory() as s:
        (await s.get(ConversationTable, conversation_id)).queued_messages = items
        await s.commit()


async def test_the_queue_is_capped(client, session_factory, seeded_user, seeded_agent, monkeypatch):
    monkeypatch.setattr(settings.inference, "queue_max_messages", 2)
    ids = await _busy_conversation(session_factory, seeded_user, seeded_agent)
    url = f"/v1/inference/runs/{seeded_user.id}/start"

    def send(text: str):
        return client.post(url, json={
            "mode": "send", "agentId": seeded_agent.id, "conversationId": ids["conversation_id"],
            "parentMessageId": ids["question"], "queue_if_busy": True,
            "message": {"sender": "user", "content": text},
        })

    assert (await send("one")).status_code == 202
    assert (await send("two")).status_code == 202
    full = await send("three")
    assert full.status_code == 409
    assert "up to 2 messages" in full.json()["detail"]
    assert [m["content"] for m in await _slot(session_factory, ids["conversation_id"])] == ["one", "two"]


async def test_the_run_end_sends_the_leading_plain_messages_stacked(
    session_factory, seeded_user, seeded_agent, monkeypatch
):
    launched: list[str] = []
    monkeypatch.setattr(composer_queue.inference_run_manager, "launch", launched.append)
    ids = await _busy_conversation(session_factory, seeded_user, seeded_agent)
    async with session_factory() as s:
        (await s.get(MessageTable, ids["run"])).streaming_status = "completed"
        await s.commit()
    run, agent = ids["run"], seeded_agent.id
    await _set_queue(session_factory, ids["conversation_id"], [
        _item("a", "first", agent, run),
        _item("b", "second", agent, run),
        _item("c", "/review it", agent, run, command={"name": "review"}),
        _item("d", "after the command", agent, run),
    ])

    assert await composer_queue.send_queued_messages(ids["conversation_id"], session_factory=session_factory)

    [new_run] = launched
    async with session_factory() as s:
        answer = await s.get(MessageTable, new_run)
        second = await s.get(MessageTable, answer.parent_message_id)
        first = await s.get(MessageTable, second.parent_message_id)
        # Stacked: each its own user message, one under the other, one answer.
        assert (first.content, first.sender, first.parent_message_id) == ("first", "user", run)
        assert (second.content, second.sender) == ("second", "user")
    # The command (a turn of its own) and what follows it wait, in order, for the new answer.
    rest = await _slot(session_factory, ids["conversation_id"])
    assert [(m["id"], m["after_run_id"]) for m in rest] == [("c", new_run), ("d", new_run)]
    assert (await _channel(ids["conversation_id"]))[-2]["queued_messages"][0]["id"] == "c"


async def test_a_run_reads_the_leading_plain_messages_and_leaves_the_rest(
    client, session_factory, seeded_user, seeded_agent, internal_headers
):
    ids = await _busy_conversation(session_factory, seeded_user, seeded_agent)
    run, agent = ids["run"], seeded_agent.id
    await _set_queue(session_factory, ids["conversation_id"], [
        _item("a", "only 2025", agent, run),
        _item("b", "and in euros", agent, run),
        _item("c", "/review", agent, run, command={"name": "review"}),
        _item("d", "then shorten it", agent, run),
    ])

    claimed = await _claim(client, ids, seeded_user, internal_headers)

    assert [m["content"] for m in claimed.json()["messages"]] == ["only 2025", "and in euros"]
    assert [m["id"] for m in await _slot(session_factory, ids["conversation_id"])] == ["c", "d"]
    async with session_factory() as s:
        rows = (await s.execute(
            select(MessageTable.content).where(MessageTable.kind == "interjection").order_by(MessageTable.created_at)
        )).scalars().all()
    assert sorted(rows) == ["and in euros", "only 2025"]


def test_a_stacked_turn_is_sent_whole_to_the_agent():
    answer = MessageTable(id="r", sender="ai")
    first = MessageTable(id="u1", sender="user", parent_message_id="r", content="first")
    second = MessageTable(id="u2", sender="user", parent_message_id="u1", content="second")
    third = MessageTable(id="u3", sender="user", parent_message_id="u2", content="third")

    turn = stacked_user_turn([answer, first, second, third], third)

    assert [m.id for m in turn] == ["u1", "u2", "u3"]
    assert [m.id for m in stacked_user_turn([answer, first], first)] == ["u1"]
