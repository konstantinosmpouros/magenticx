"""Run records in Postgres: listing, the active-run limits, creating the
placeholder answer, cancel/resume requests and the restart cleanup.
"""

from datetime import timedelta
from typing import Any
from uuid import uuid4
from fastapi import HTTPException, status
from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from core.database import (
    AgentTable,
    ConversationTable,
    MessageTable,
    SessionLocal,
)
from core.settings import settings
from core.logging import get_logger
from engine.conversations.compaction_lock import compaction_locks
from engine.inference.hitl import (
    ResumeOutcome,
)
from engine.inference.history import (
    nearest_committed_ai,
    resolve_inference_message_path,
)
from engine.inference.runs.state import ACTIVE_RUN_STATUSES, _now
from engine.inference.runs.manager import inference_run_manager

logger = get_logger(__name__)


MAX_ACTIVE_RUNS_PER_USER = settings.rate_limit.inference_max_active_runs


STALE_QUEUED_RUN_AFTER = timedelta(minutes=2)


async def get_active_run_for_user(db: AsyncSession, user_id: str, run_id: str) -> MessageTable | None:
    """Load an inference run (assistant message with a streaming status) scoped to its owner."""
    result = await db.execute(
        select(MessageTable)
        .join(ConversationTable, ConversationTable.id == MessageTable.conversation_id)
        .where(
            MessageTable.id == run_id,
            ConversationTable.user_id == user_id,
            MessageTable.streaming_status.is_not(None),
        )
    )
    return result.scalar_one_or_none()


async def list_runs_for_user(
    db: AsyncSession, user_id: str, status_filter: str | None
) -> list[MessageTable]:
    """List the user's inference runs, optionally filtered by streaming status.

    A "Try it" trial's runs (plan 40) are left out: the builder's panel
    observes its own run, and the chat's global hydration must not adopt it.
    """
    stmt = (
        select(MessageTable)
        .join(ConversationTable, ConversationTable.id == MessageTable.conversation_id)
        .where(
            ConversationTable.user_id == user_id,
            ConversationTable.is_trial.is_(False),
            MessageTable.streaming_status.is_not(None),
        )
    )
    if status_filter == "active":
        stmt = stmt.where(MessageTable.streaming_status.in_(ACTIVE_RUN_STATUSES))
    elif status_filter:
        stmt = stmt.where(MessageTable.streaming_status == status_filter)
    stmt = stmt.order_by(MessageTable.streaming_started_at.desc())
    result = await db.execute(stmt)
    return list(result.scalars().all())


def _is_active_run_integrity_conflict(exc: IntegrityError) -> bool:
    text = str(exc.orig).lower()
    return (
        "uq_messages_one_active_stream_per_conversation" in text
        or "messages_conversation_id" in text
    )


async def _fail_stale_queued_runs_for_conversation(db: AsyncSession, conversation_id: str) -> None:
    """Reap assistant-message rows that have been stuck in ``queued`` longer than
    :data:`STALE_QUEUED_RUN_AFTER` without anyone owning the asyncio task.
    """
    cutoff = _now() - STALE_QUEUED_RUN_AFTER
    stale_result = await db.execute(
        select(MessageTable).where(
            MessageTable.conversation_id == conversation_id,
            MessageTable.streaming_status == "queued",
            MessageTable.streaming_started_at < cutoff,
        )
    )
    stale_runs = stale_result.scalars().all()
    if not stale_runs:
        return

    now = _now()
    failed_run_ids: set[str] = set()
    for run in stale_runs:
        if inference_run_manager.has_live_task(run.id):
            continue
        failed_run_ids.add(run.id)
        run.streaming_status = "failed"
        run.streaming_completed_at = now
        run.is_error = True
        run.error_message = "Inference run was queued but never launched."
        run.updated_at = now
    if not failed_run_ids:
        return
    conversation = await db.get(ConversationTable, conversation_id)
    if conversation and conversation.active_assistant_message_id in failed_run_ids:
        conversation.active_assistant_message_id = None


async def create_inference_run_record(
    *,
    db: AsyncSession,
    user_id: str,
    conversation: ConversationTable,
    parent_message_id: str,
    message_path: list[str] | None,
    agent: AgentTable,
    mode: str,
    scheduled_task_id: str | None = None,
) -> MessageTable:
    """Create the AI placeholder message that represents the run.

    After the inference_runs-table collapse the run *is* the assistant message —
    the returned row carries both the streaming_* lifecycle columns and the
    final content/raw_events fields once the run terminates.

    ``mode`` drives durable-checkpointer branch allocation: ``send`` continues
    the leaf branch (inherit the nearest committed AI ancestor's
    ``checkpoint_thread_id``); every other mode (new/edit/retry/shared_continue)
    starts a fresh branch thread. The per-turn delta-vs-fork-vs-full decision is
    re-derived in ``_run`` from the message tree.
    """
    # Every run starts here, whatever the route, so this is where agent access is
    # enforced: a platform agent, or a custom agent the user owns. An agent id is
    # otherwise just a string the client sends (or a share snapshot carries).
    if agent.owner_user_id is not None and agent.owner_user_id != user_id:
        logger.warning("inference_agent_not_owned", "Refused a run on another user's private agent",
                       agent_id=agent.id, failure_reason="agent_not_owned")
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="This agent is private to its owner.")

    await _fail_stale_queued_runs_for_conversation(db, conversation.id)

    user_active_count = await db.scalar(
        select(func.count())
        .select_from(MessageTable)
        .join(ConversationTable, ConversationTable.id == MessageTable.conversation_id)
        .where(
            ConversationTable.user_id == user_id,
            MessageTable.streaming_status.in_(ACTIVE_RUN_STATUSES),
        )
    )
    if user_active_count >= MAX_ACTIVE_RUNS_PER_USER:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=f"You already have {MAX_ACTIVE_RUNS_PER_USER} active inference runs. Cancel one before starting a new one.",
        )

    existing = await db.execute(
        select(MessageTable).where(
            MessageTable.conversation_id == conversation.id,
            MessageTable.streaming_status.in_(ACTIVE_RUN_STATUSES),
        )
    )
    if existing.scalar_one_or_none() is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Conversation already has an active inference run.")
    # A manual compaction rewrites the branch's state; a run must not build on
    # the state it is about to replace (plan 34).
    if await compaction_locks.held(conversation.id):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This conversation is being compacted. Try again in a moment.",
        )

    parent = next((message for message in conversation.messages if message.id == parent_message_id), None)
    if not parent:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Parent message does not belong to this conversation.")

    parent_path = resolve_inference_message_path(conversation.messages, parent_message_id, message_path)

    # Branch-thread allocation. `send` continues the same linear branch, so it
    # resumes the nearest committed ancestor's thread; new/edit/retry/
    # shared_continue each start a fresh branch (a sibling row or a new
    # conversation) on its own thread, which `_run` seeds via copy-on-fork or a
    # full-history cold seed.
    if mode == "send":
        committed_ancestor = nearest_committed_ai(conversation.messages, parent_message_id)
        checkpoint_thread_id = (
            committed_ancestor.checkpoint_thread_id if committed_ancestor is not None else str(uuid4())
        )
    else:
        checkpoint_thread_id = str(uuid4())

    now = _now()
    assistant_message = MessageTable(
        conversation_id=conversation.id,
        parent_message_id=parent_message_id,
        sender="ai",
        content="",
        raw_events=[],
        agent_id=agent.id,
        agent_name=agent.name,
        streaming_status="queued",
        streaming_started_at=now,
        # After the user message it answers, never tied with it (see init_message).
        created_at=now,
        checkpoint_thread_id=checkpoint_thread_id,
        scheduled_task_id=scheduled_task_id,
    )
    db.add(assistant_message)
    try:
        await db.flush()
    except IntegrityError as exc:
        await db.rollback()
        if _is_active_run_integrity_conflict(exc):
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Conversation already has an active inference run.") from exc
        raise

    # The streaming message path includes the new assistant message itself so the
    # detached task can hand it to the agent as the tail of the conversation
    # history. We have to set this after flush() so the id is available.
    assistant_message.streaming_message_path = [*parent_path, assistant_message.id]

    conversation.active_assistant_message_id = assistant_message.id
    conversation.last_message_at = now
    # The conversation's agent is a last-used pointer (per-message agent is on
    # the message rows), so reflect the agent that produced this run.
    conversation.agent_id = agent.id
    conversation.agent_name = agent.name
    return assistant_message


async def request_run_cancel(db: AsyncSession, run: MessageTable) -> MessageTable:
    if run.streaming_status not in ACTIVE_RUN_STATUSES:
        return run
    run.streaming_status = "cancelling"
    run.streaming_cancel_requested_at = _now()
    has_live_task = inference_run_manager.request_cancel(run.id)
    if not has_live_task:
        # No live task to interrupt — flip straight to cancelled without
        # touching content (we keep whatever the message already had).
        now = _now()
        run.streaming_status = "cancelled"
        run.streaming_completed_at = now
        run.updated_at = now
        conversation = await db.get(ConversationTable, run.conversation_id)
        if conversation and conversation.active_assistant_message_id == run.id:
            conversation.active_assistant_message_id = None
    await db.commit()
    await db.refresh(run)
    return run


async def request_run_resume(run: MessageTable, payload: dict[str, Any]) -> ResumeOutcome:
    """Hand a HITL resume decision to the live manager task.

    Returns the :class:`ResumeOutcome`; the route answers 409 with its
    ``detail`` unless it is ``accepted``. Refused when the run already
    terminated, was cancelled, the bridge restarted between interrupt and
    resume, or the decision does not answer an interrupt the run is paused on
    (see :meth:`InferenceRunManager.request_resume`).
    """
    if run.streaming_status not in ACTIVE_RUN_STATUSES:
        return ResumeOutcome.NOT_PAUSED
    return inference_run_manager.request_resume(run.id, payload)


async def cleanup_orphaned_inference_runs() -> None:
    """On service startup, flip every assistant-message that was mid-stream into
    ``failed`` so it doesn't appear active to hydrating clients indefinitely.
    """
    async with SessionLocal() as db:
        now = _now()
        await db.execute(
            update(MessageTable)
            .where(MessageTable.streaming_status.in_(ACTIVE_RUN_STATUSES))
            .values(
                streaming_status="failed",
                streaming_completed_at=now,
                is_error=True,
                error_message="Inference run was interrupted by service restart.",
                updated_at=now,
            )
        )
        await db.execute(
            update(ConversationTable)
            .where(ConversationTable.active_assistant_message_id.is_not(None))
            .values(active_assistant_message_id=None)
        )
        await db.commit()
