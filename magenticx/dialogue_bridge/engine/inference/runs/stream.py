"""Replaying a run's frames to a client: the snapshot, then the live tail of its
event log until the terminal frame, framed as Server-Sent Events.
"""

from typing import Any, AsyncIterator
from sqlalchemy import select
from core.database import (
    MessageTable,
    SessionLocal,
)
from core.logging import get_logger
from core.settings import settings
from engine.inference.event_log import event_log
from engine.inference.runs.state import TERMINAL_RUN_STATUSES
from engine.inference.runs.payloads import _load_run, build_run_event_payload
from engine.inference.runs.manager import inference_run_manager
from utils.sse import format_sse, with_heartbeat

logger = get_logger(__name__)


SNAPSHOT_SEQ_SENTINEL = "__snapshot__"


async def build_terminal_payload(run_id: str) -> dict[str, Any] | None:
    """The DB-built final state sent with the closing ``terminal`` frame, or
    None when it cannot be built (the client then keeps what it folded).

    It is what makes a lost terminal stream entry harmless: the client applies
    this before it stops, so the run flips to its real status anyway.
    """
    try:
        async with SessionLocal() as db:
            return await build_run_event_payload(db, run_id, "terminal")
    except Exception:
        logger.warning(
            "run_terminal_payload_failed",
            "Failed to build terminal payload; sending a bare terminal frame",
            exc_info=True,
            run_id=run_id,
        )
        return None


async def stream_run_events(
    run_id: str,
    since: str | None = None,
) -> AsyncIterator[tuple[str, dict[str, Any]]]:
    """Yield ``(seq, event)`` pairs from the run's stream (framed for SSE below).

    The entry ID is exposed as the ``seq`` cursor so the client can resume
    after disconnect. Frames carrying the :data:`SNAPSHOT_SEQ_SENTINEL` seq
    must NOT be sent back as a ``since`` cursor.

    - Terminal run: one DB-built snapshot frame, then return.
    - Fresh subscribe (``since`` is None) on an in-flight run owned by this
      process: one synthesized live snapshot frame (full coalesced log), then
      live-tail from the stream position captured *before* the snapshot was
      built. Events published in between appear in both — the client's
      per-event ``seq`` guard dedupes them.
    - Reconnect (``since`` given) or no in-process runtime: plain Redis replay.
    """
    async with SessionLocal() as db:
        run = await _load_run(db, run_id)
        if run and run.streaming_status in TERMINAL_RUN_STATUSES:
            snapshot = await build_run_event_payload(db, run_id, "snapshot")
            if snapshot:
                yield (SNAPSHOT_SEQ_SENTINEL, snapshot)
            return

    cursor = since
    if cursor is None:
        last_entry_id = await event_log.last_entry_id(run_id)
        live_snapshot = inference_run_manager.build_live_snapshot(run_id)
        if live_snapshot is not None:
            yield (SNAPSHOT_SEQ_SENTINEL, live_snapshot)
            cursor = last_entry_id

    # Escape hatch for the tail loop: if the run reaches a terminal status in
    # the DB but its terminal frame never flows through this consumer's XREAD
    # (publish raced the subscribe, stream trimmed), the generator would block
    # forever and the client would never get the closing terminal frame.
    async def _run_went_terminal() -> bool:
        async with SessionLocal() as idle_db:
            status_value = await idle_db.scalar(
                select(MessageTable.streaming_status).where(MessageTable.id == run_id)
            )
        return status_value is None or status_value in TERMINAL_RUN_STATUSES

    async for entry_id, event in event_log.read_since(
        run_id,
        cursor if cursor else "0",
        terminal_statuses=TERMINAL_RUN_STATUSES,
        on_idle=_run_went_terminal,
    ):
        yield (entry_id, event)


async def _run_sse_events(run_id: str, since: str | None) -> AsyncIterator[bytes]:
    """The run's frames as SSE events — the frames of
    :func:`stream_run_events`, in order:

    - ``event: snapshot`` (no ``id``: the snapshot sentinel is never a cursor);
    - ``event: event`` with ``id: <seq>`` — one per Redis stream entry, i.e. the
      new AG-UI events of ONE upstream chunk. Deltas only: never the whole run
      per token, which is what made the first SSE version stutter;
    - ``event: terminal`` with the DB-built final state, then the stream ends.

    Each entry becomes one event, written as soon as it is read; nothing is
    batched on the server.
    """
    async for seq, event in stream_run_events(run_id, since=since):
        if seq == SNAPSHOT_SEQ_SENTINEL:
            yield format_sse(event, event="snapshot")
        else:
            yield format_sse(event, event="event", event_id=seq)
    yield format_sse(await build_terminal_payload(run_id), event="terminal")


def stream_run_sse(run_id: str, since: str | None = None) -> AsyncIterator[bytes]:
    """The SSE body of ``GET …/runs/{user}/{run}/events``: the run's frames
    (:func:`_run_sse_events`) with a ``: ping`` comment whenever it is quiet
    for ``INFERENCE_SSE_HEARTBEAT_SECONDS`` — a run thinking or paused at an
    approval must not be cut by an idle proxy timeout."""
    return with_heartbeat(
        _run_sse_events(run_id, since),
        settings.inference.sse_heartbeat_seconds,
    )
