"""The run's SSE stream (SSE plan, phase 1) and the generic SSE helpers.

Pinned: an event is one line of compact JSON with its `id` / `event`; the
heartbeat interleaves `: ping` while the source is quiet without dropping,
batching or cancelling a frame, and closes the source on exit; the stream
carries the run's frames — a snapshot (no id), one event per
stream entry with `id: <seq>`, then the terminal state — deltas, never the
whole run; the route answers 404 / 400 before streaming, resumes from `since`
or `Last-Event-ID`, and sends the no-buffer / no-transform headers.
"""
from __future__ import annotations

import asyncio
import json

import pytest

from core.database import ConversationTable, MessageTable
import engine.inference.runs.finish as run_finish
import engine.inference.runs.manager as run_manager
import engine.inference.runs.records as run_records
import engine.inference.runs.state as run_state
import engine.inference.runs.stream as run_stream
from engine.inference.runs.stream import stream_run_sse
from utils.sse import HEARTBEAT_COMMENT, SSE_RESPONSE_HEADERS, format_sse, with_heartbeat


@pytest.fixture
def patch_session_local(monkeypatch, session_factory):
    """Route the run modules that open their own SessionLocal() at the test DB."""
    for run_module in (run_finish, run_manager, run_records, run_stream):
        monkeypatch.setattr(run_module, "SessionLocal", session_factory)
    return session_factory


def _parse(body: bytes) -> list[dict]:
    """Split an SSE body into its events: comments as {"comment"}, events as {id, event, data}."""
    out: list[dict] = []
    for block in body.decode("utf-8").split("\n\n"):
        if not block:
            continue
        if block.startswith(":"):
            out.append({"comment": block})
            continue
        fields: dict = {}
        for line in block.split("\n"):
            key, _, value = line.partition(": ")
            fields[key] = value
        out.append({"id": fields.get("id"), "event": fields.get("event"), "data": json.loads(fields["data"])})
    return out


async def _seed_run(session_factory, seeded_user, seeded_agent, status: str) -> str:
    async with session_factory() as session:
        conversation = ConversationTable(
            user_id=seeded_user.id,
            agent_id=seeded_agent.id,
            agent_name=seeded_agent.name,
            title="SSE",
        )
        session.add(conversation)
        await session.flush()
        run = MessageTable(
            conversation_id=conversation.id,
            sender="ai",
            content="final answer" if status == "completed" else "",
            streaming_status=status,
            streaming_started_at=run_state._now(),
            raw_events=[],
        )
        session.add(run)
        await session.commit()
        await session.refresh(run)
        return run.id


def _patch_read_since(monkeypatch, entries):
    """The Redis live tail: ``(entry_id, event)`` pairs, then the end of the run."""
    seen: dict = {}

    async def fake_read_since(run_id, cursor, *, terminal_statuses, cancel_event=None, on_idle=None):
        seen["cursor"] = cursor
        for entry in entries:
            yield entry

    monkeypatch.setattr(run_manager.event_log, "read_since", fake_read_since)
    return seen


# ---------------------------------------------------------------------------
# utils.sse
# ---------------------------------------------------------------------------
def test_format_sse_is_one_compact_line_with_id_and_event():
    frame = format_sse({"text": "a\nb", "n": 1}, event="event", event_id="17-0")
    assert frame == b'id: 17-0\nevent: event\ndata: {"text":"a\\nb","n":1}\n\n'


def test_format_sse_without_id_or_event_is_data_only():
    assert format_sse(None) == b"data: null\n\n"


async def test_heartbeat_interleaves_pings_without_losing_or_batching_frames():
    async def slow_source():
        yield b"first"
        await asyncio.sleep(0.12)
        yield b"second"

    chunks = [chunk async for chunk in with_heartbeat(slow_source(), 0.05)]
    assert chunks[0] == b"first"
    assert chunks[-1] == b"second"
    # The quiet gap was filled by comments, and nothing else was added or merged.
    assert HEARTBEAT_COMMENT in chunks[1:-1]
    assert set(chunks[1:-1]) == {HEARTBEAT_COMMENT}


async def test_heartbeat_closes_the_source_when_the_consumer_leaves():
    closed = asyncio.Event()

    async def endless_source():
        try:
            while True:
                await asyncio.sleep(1)
                yield b"never"
        finally:
            closed.set()

    stream = with_heartbeat(endless_source(), 0.01)
    assert await stream.__anext__() == HEARTBEAT_COMMENT
    await stream.aclose()
    assert closed.is_set()


# ---------------------------------------------------------------------------
# engine: the run's frames as SSE
# ---------------------------------------------------------------------------
async def test_terminal_run_streams_snapshot_then_terminal(
    patch_session_local, session_factory, seeded_user, seeded_agent
):
    run_id = await _seed_run(session_factory, seeded_user, seeded_agent, "completed")
    events = _parse(b"".join([chunk async for chunk in stream_run_sse(run_id)]))
    assert [e["event"] for e in events] == ["snapshot", "terminal"]
    # The snapshot sentinel is never a cursor.
    assert events[0]["id"] is None
    assert events[0]["data"]["run"]["id"] == run_id
    assert events[1]["data"]["run"]["status"] == "completed"


async def test_live_tail_is_one_event_per_entry_with_its_seq(
    patch_session_local, session_factory, seeded_user, seeded_agent, monkeypatch
):
    run_id = await _seed_run(session_factory, seeded_user, seeded_agent, "running")
    delta_1 = {"type": "events", "events": [{"type": "TEXT_MESSAGE_CONTENT", "delta": "Hel", "seq": 1}]}
    delta_2 = {"type": "events", "events": [{"type": "TEXT_MESSAGE_CONTENT", "delta": "lo", "seq": 2}]}
    seen = _patch_read_since(monkeypatch, [("5-0", delta_1), ("6-0", delta_2)])

    events = _parse(b"".join([chunk async for chunk in stream_run_sse(run_id, since="4-0")]))

    assert seen["cursor"] == "4-0"
    assert [(e["event"], e["id"]) for e in events] == [("event", "5-0"), ("event", "6-0"), ("terminal", None)]
    # Deltas only: each event carries its own chunk, not the run so far.
    assert events[0]["data"] == delta_1
    assert events[1]["data"] == delta_2


# ---------------------------------------------------------------------------
# router: GET /v1/inference/runs/{user}/{run}/events
# ---------------------------------------------------------------------------
async def test_route_streams_with_no_buffer_headers(
    client, patch_session_local, session_factory, seeded_user, seeded_agent, monkeypatch
):
    run_id = await _seed_run(session_factory, seeded_user, seeded_agent, "running")
    _patch_read_since(monkeypatch, [("9-0", {"type": "events", "events": []})])

    response = await client.get(
        f"/v1/inference/runs/{seeded_user.id}/{run_id}/events", params={"since": "8-0"}
    )

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    for header, value in SSE_RESPONSE_HEADERS.items():
        assert response.headers[header] == value
    assert [e["event"] for e in _parse(response.content)] == ["event", "terminal"]


async def test_route_resumes_from_last_event_id(
    client, patch_session_local, session_factory, seeded_user, seeded_agent, monkeypatch
):
    run_id = await _seed_run(session_factory, seeded_user, seeded_agent, "running")
    seen = _patch_read_since(monkeypatch, [])

    response = await client.get(
        f"/v1/inference/runs/{seeded_user.id}/{run_id}/events", headers={"Last-Event-ID": "12-3"}
    )

    assert response.status_code == 200
    assert seen["cursor"] == "12-3"


async def test_route_404s_for_an_unknown_run(client, patch_session_local, seeded_user):
    response = await client.get(f"/v1/inference/runs/{seeded_user.id}/no-such-run/events")
    assert response.status_code == 404


async def test_route_400s_for_a_cursor_that_is_not_a_stream_id(
    client, patch_session_local, session_factory, seeded_user, seeded_agent
):
    run_id = await _seed_run(session_factory, seeded_user, seeded_agent, "running")
    response = await client.get(
        f"/v1/inference/runs/{seeded_user.id}/{run_id}/events", params={"since": "0; DROP"}
    )
    assert response.status_code == 400
