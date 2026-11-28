"""The one-shot boot job that has the agents service import every branch's legacy scratch files.

Pinned here: every (thread, user, conversation) a message records is sent once,
in batches; a batch the agents service does not take yet is retried until it
does; and the job ends quietly when the bridge stops. Delete with the job.
"""
from __future__ import annotations

import asyncio

import httpx

import engine.conversations.legacy_scratch_import as legacy_scratch_import
from core.database import ConversationTable, MessageTable


async def _conversation(session_factory, user, agent, threads):
    async with session_factory() as s:
        conversation = ConversationTable(user_id=user.id, agent_id=agent.id, title="t")
        s.add(conversation)
        await s.flush()
        for thread in threads:
            s.add(MessageTable(conversation_id=conversation.id, sender="ai", content="",
                               checkpoint_thread_id=thread))
        s.add(MessageTable(conversation_id=conversation.id, sender="user", content="no thread"))
        await s.commit()
        return conversation.id


def _wire(monkeypatch, session_factory, answers):
    """Record what is sent; ``answers`` is popped per call (an exception, or files imported)."""
    sent: list[list[dict]] = []

    async def send(client, batch):
        sent.append(batch)
        answer = answers.pop(0) if answers else 0
        if isinstance(answer, Exception):
            raise answer
        return answer

    monkeypatch.setattr(legacy_scratch_import, "SessionLocal", session_factory)
    monkeypatch.setattr(legacy_scratch_import, "_send", send)
    return sent


async def test_every_branch_is_sent_once_with_its_conversation_and_user(
    monkeypatch, session_factory, seeded_user, seeded_agent
):
    first = await _conversation(session_factory, seeded_user, seeded_agent, ["t-a", "t-b", "t-a"])
    second = await _conversation(session_factory, seeded_user, seeded_agent, ["t-c"])
    sent = _wire(monkeypatch, session_factory, [3])

    assert await legacy_scratch_import.run_legacy_scratch_import(asyncio.Event()) == 3

    [batch] = sent
    assert sorted((b["thread_id"], b["conversation_id"], b["user_id"]) for b in batch) == sorted([
        ("t-a", first, seeded_user.id), ("t-b", first, seeded_user.id), ("t-c", second, seeded_user.id),
    ])


async def test_branches_go_in_batches(monkeypatch, session_factory, seeded_user, seeded_agent):
    await _conversation(session_factory, seeded_user, seeded_agent, ["t-a", "t-b", "t-c"])
    monkeypatch.setattr(legacy_scratch_import, "BATCH", 2)
    sent = _wire(monkeypatch, session_factory, [1, 1])

    assert await legacy_scratch_import.run_legacy_scratch_import(asyncio.Event()) == 2
    assert [len(batch) for batch in sent] == [2, 1]


async def test_a_batch_the_agents_service_does_not_take_is_retried(
    monkeypatch, session_factory, seeded_user, seeded_agent
):
    await _conversation(session_factory, seeded_user, seeded_agent, ["t-a"])
    monkeypatch.setattr(legacy_scratch_import, "FIRST_RETRY_SECONDS", 0.01)
    unavailable = httpx.HTTPStatusError("503", request=httpx.Request("POST", "http://agents"),
                                        response=httpx.Response(503))
    sent = _wire(monkeypatch, session_factory, [httpx.ConnectError("starting"), unavailable, 2])

    assert await legacy_scratch_import.run_legacy_scratch_import(asyncio.Event()) == 2
    assert len(sent) == 3 and sent[0] == sent[2]


async def test_it_stops_waiting_when_the_bridge_stops(monkeypatch, session_factory, seeded_user, seeded_agent):
    await _conversation(session_factory, seeded_user, seeded_agent, ["t-a"])
    monkeypatch.setattr(legacy_scratch_import, "FIRST_RETRY_SECONDS", 30)
    _wire(monkeypatch, session_factory, [httpx.ConnectError("down")] * 5)
    stop = asyncio.Event()

    task = asyncio.create_task(legacy_scratch_import.run_legacy_scratch_import(stop))
    await asyncio.sleep(0.05)
    stop.set()
    assert await asyncio.wait_for(task, timeout=2) == 0


async def test_no_branches_sends_nothing(monkeypatch, session_factory):
    sent = _wire(monkeypatch, session_factory, [])

    assert await legacy_scratch_import.run_legacy_scratch_import(asyncio.Event()) == 0
    assert sent == []
