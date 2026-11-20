"""Replaying a run's frames to a client: the snapshot, then the live tail of its
event log until the terminal frame.
"""

from typing import Any, AsyncIterator
from sqlalchemy import select
from core.database import (
    MessageTable,
    SessionLocal,
)
from core.logging import get_logger
from engine.inference.event_log import event_log
from engine.inference.runs.state import TERMINAL_RUN_STATUSES
from engine.inference.runs.payloads import _load_run, build_run_event_payload
from engine.inference.runs.manager import inference_run_manager

logger = get_logger(__name__)


SNAPSHOT_SEQ_SENTINEL = "__snapshot__"


async def stream_run_events(
    run_id: str,
    since: str | None = None,
) -> AsyncIterator[tuple[str, dict[str, Any]]]:
    """Yield ``(seq, event)`` pairs from the run's stream for WebSocket consumers.

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
