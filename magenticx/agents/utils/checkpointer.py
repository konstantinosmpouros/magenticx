from __future__ import annotations

from typing import Any

from core.logging import get_logger
from harness.agui.emitter import encode
from harness.agui.normalizer import release_run_memory

logger = get_logger(__name__)


async def release_checkpoint_unless_paused(agent: Any, run_id: str) -> None:
    """Drop the normalizer's in-process run memory when a run ends — unless the
    graph is parked on a HITL interrupt, in which case keep it so a later
    ``/resume`` still knows which background tasks it already announced.

    The durable Postgres checkpoint is **never** deleted here: threads persist
    across turns (that is the whole point of the durable saver), and reaping is
    done only on conversation delete. This helper now manages exclusively the
    per-run RAM cache keyed by ``run_id`` (the assistant message id). The
    interrupt probe is async because the saver is ``AsyncPostgresSaver`` — the
    sync ``get_state`` is unavailable on an async saver. When the interrupt
    state can't be read we drop the cache (favour a tidy cache over a rare
    repeated TASK_LAUNCHED; the durable checkpoint is unaffected either way).
    """
    if not run_id:
        return
    try:
        aget_state = getattr(getattr(agent, "compiled", None), "aget_state", None)
        if aget_state is not None:
            snapshot = await aget_state(agent.run_config)
            if list(getattr(snapshot, "interrupts", None) or []):
                return
    except Exception:
        logger.warning(
            "checkpoint_interrupt_probe_failed",
            "Could not determine interrupt state; releasing the run memory",
            exc_info=True,
        )
    release_run_memory(run_id)


async def emit_checkpoint_committed(
    agent: Any, thread_id: str, agent_logger: Any, request_context: Any
) -> Any:
    """Read the durable checkpoint head this run produced and encode it as a
    terminal AG-UI CHECKPOINT_COMMITTED frame (or None). The bridge persists
    ``(thread_id, checkpoint_id)`` on the assistant message so the next turn
    resumes and edit/retry fork from this head."""
    if not thread_id:
        return None
    try:
        aget_state = getattr(getattr(agent, "compiled", None), "aget_state", None)
        if aget_state is None:
            return None
        snapshot = await aget_state(agent.run_config)
        cfg = getattr(snapshot, "config", None) or {}
        checkpoint_id = (cfg.get("configurable") or {}).get("checkpoint_id")
        return encode(agent.agui_emitter.checkpoint_committed(thread_id=thread_id, checkpoint_id=checkpoint_id))
    except Exception:
        agent_logger.warning(
            "checkpoint_commit_emit_failed",
            "Failed to read/emit committed checkpoint head",
            context=request_context,
            exc_info=True,
        )
        return None
