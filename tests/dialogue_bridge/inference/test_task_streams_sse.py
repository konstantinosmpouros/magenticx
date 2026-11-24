"""The conversation channel and a task's drill-down over SSE (SSE plan, phase 2).

Pinned: each frame becomes one SSE event carrying the frame
unchanged as its data, the frame's ``type`` as ``event`` and its ``seq`` as
``id``; the routes check ownership (404) and the cursor (400) before the
stream opens, resume from ``since`` / ``Last-Event-ID``, and send the
no-buffer / no-transform headers.
"""
from __future__ import annotations

import json
from typing import Any

import pytest

from core.database import ConversationTable
import router.inference.tasks as tasks_router
from utils.sse import SSE_RESPONSE_HEADERS, frames_to_sse


def _parse(body: bytes) -> list[dict]:
    """Split an SSE body into its events ({id, event, data}); comments are dropped."""
    out: list[dict] = []
    for block in body.decode("utf-8").split("\n\n"):
        if not block or block.startswith(":"):
            continue
        fields: dict = {}
        for line in block.split("\n"):
            key, _, value = line.partition(": ")
            fields[key] = value
        out.append({"id": fields.get("id"), "event": fields.get("event"), "data": json.loads(fields["data"])})
    return out


async def _frames(items: list[dict[str, Any]]):
    for item in items:
        yield item


async def _seed_conversation(session_factory, user, agent) -> str:
    async with session_factory() as session:
        conversation = ConversationTable(user_id=user.id, agent_id=agent.id, agent_name=agent.name, title="SSE")
        session.add(conversation)
        await session.commit()
        return conversation.id


# ---------------------------------------------------------------------------
# utils.sse.frames_to_sse
# ---------------------------------------------------------------------------
async def test_each_frame_is_one_event_named_by_type_with_its_seq_as_id():
    frames = [
        {"type": "queue", "queued_messages": []},
        {"type": "task", "event": "TASK_STARTED", "seq": "5-0"},
    ]
    body = b"".join([chunk async for chunk in frames_to_sse(_frames(frames), 15)])

    events = _parse(body)
    assert [(e["event"], e["id"]) for e in events] == [("queue", None), ("task", "5-0")]
    # The data is the frame itself, unchanged.
    assert [e["data"] for e in events] == frames


# ---------------------------------------------------------------------------
# GET /v1/conversations/{user}/{conversation}/events
# ---------------------------------------------------------------------------
@pytest.fixture
def channel_frames_seen(monkeypatch):
    """Stub the channel tail: record the cursor, serve a queue frame and one task frame."""
    seen: dict[str, Any] = {}

    def fake_channel_frames(conversation_id, since, queued):
        seen.update(conversation_id=conversation_id, since=since, queued=queued)
        return _frames([
            {"type": "queue", "queued_messages": []},
            {"type": "task", "event": "TASK_STARTED", "task": {"task_id": "t"}, "seq": "7-1"},
        ])

    monkeypatch.setattr(tasks_router, "channel_frames", fake_channel_frames)
    return seen


async def test_channel_streams_the_socket_frames_with_no_buffer_headers(
    client, session_factory, seeded_user, seeded_agent, channel_frames_seen
):
    conversation_id = await _seed_conversation(session_factory, seeded_user, seeded_agent)

    response = await client.get(f"/v1/conversations/{seeded_user.id}/{conversation_id}/events")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    for header, value in SSE_RESPONSE_HEADERS.items():
        assert response.headers[header] == value
    events = _parse(response.content)
    assert [(e["event"], e["id"]) for e in events] == [("queue", None), ("task", "7-1")]
    assert channel_frames_seen["conversation_id"] == conversation_id
    assert channel_frames_seen["since"] is None


async def test_channel_resumes_from_last_event_id(
    client, session_factory, seeded_user, seeded_agent, channel_frames_seen
):
    conversation_id = await _seed_conversation(session_factory, seeded_user, seeded_agent)

    response = await client.get(
        f"/v1/conversations/{seeded_user.id}/{conversation_id}/events", headers={"Last-Event-ID": "7-1"}
    )

    assert response.status_code == 200
    assert channel_frames_seen["since"] == "7-1"


async def test_channel_404s_for_a_conversation_the_user_does_not_own(client, seeded_user, channel_frames_seen):
    response = await client.get(f"/v1/conversations/{seeded_user.id}/not-mine/events")
    assert response.status_code == 404
    assert channel_frames_seen == {}


async def test_channel_400s_for_a_cursor_that_is_not_a_stream_id(
    client, session_factory, seeded_user, seeded_agent, channel_frames_seen
):
    conversation_id = await _seed_conversation(session_factory, seeded_user, seeded_agent)
    response = await client.get(
        f"/v1/conversations/{seeded_user.id}/{conversation_id}/events", params={"since": "$"}
    )
    assert response.status_code == 400
    assert channel_frames_seen == {}


# ---------------------------------------------------------------------------
# GET /v1/tasks/{user}/{task}/events
# ---------------------------------------------------------------------------
async def test_task_stream_serves_snapshot_events_and_terminal(client, seeded_user, monkeypatch):
    seen: dict[str, Any] = {}

    async def owned(_db, user_id, task_id):
        return object() if (user_id, task_id) == (seeded_user.id, "task-1") else None

    def fake_stream(user_id, task_id, since):
        seen.update(user_id=user_id, task_id=task_id, since=since)
        return _frames([
            {"type": "snapshot", "task": {"task_id": "task-1"}},
            {"type": "event", "seq": "3-0", "event": {"type": "TEXT_MESSAGE_CONTENT"}},
            {"type": "terminal", "status": "success"},
        ])

    monkeypatch.setattr(tasks_router, "get_owned_task", owned)
    monkeypatch.setattr(tasks_router, "stream_task_events", fake_stream)

    response = await client.get(f"/v1/tasks/{seeded_user.id}/task-1/events", params={"since": "2-0"})

    assert response.status_code == 200
    events = _parse(response.content)
    assert [(e["event"], e["id"]) for e in events] == [("snapshot", None), ("event", "3-0"), ("terminal", None)]
    assert seen == {"user_id": seeded_user.id, "task_id": "task-1", "since": "2-0"}


async def test_task_stream_404s_for_a_task_the_user_does_not_own(client, seeded_user, monkeypatch):
    async def owned(_db, _user_id, _task_id):
        return None

    monkeypatch.setattr(tasks_router, "get_owned_task", owned)
    response = await client.get(f"/v1/tasks/{seeded_user.id}/someone-elses/events")
    assert response.status_code == 404
