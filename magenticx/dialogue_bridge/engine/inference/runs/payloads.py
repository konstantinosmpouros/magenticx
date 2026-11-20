"""A run as the UI sees it: ``InferenceRunOut`` built from its assistant message,
and the terminal/snapshot frame payload.
"""

from typing import Any
from sqlalchemy import select
from sqlalchemy.orm import selectinload
from sqlalchemy.ext.asyncio import AsyncSession
from core.database import (
    AttachmentTable,
    ConversationTable,
    MessageTable,
)
from core.logging import get_logger
from schema import ConversationSummary, InferenceRunOut, MessageOut

logger = get_logger(__name__)


async def _load_run(db: AsyncSession, run_id: str) -> MessageTable | None:
    """Load the AI message that represents a streaming run.

    ``run_id`` is the assistant message ID — after the InferenceRunTable collapse
    the message row carries the streaming_* columns that used to live there.
    """
    result = await db.execute(select(MessageTable).where(MessageTable.id == run_id))
    return result.scalar_one_or_none()


async def _load_message(db: AsyncSession, message_id: str) -> MessageTable | None:
    result = await db.execute(
        select(MessageTable)
        .options(selectinload(MessageTable.attachments).selectinload(AttachmentTable.blob))
        .where(MessageTable.id == message_id)
    )
    return result.scalar_one_or_none()


def build_run_out_from_message(message: MessageTable, *, user_id: str) -> InferenceRunOut:
    """Build the wire-shape :class:`InferenceRunOut` from a :class:`MessageTable`.

    After the inference_runs-table collapse the "run" is just the assistant
    message with ``streaming_*`` columns. The wire shape is preserved so the
    frontend doesn't need a parallel migration: ``id`` and ``assistantMessageId``
    are both the message ID.
    """
    started = message.streaming_started_at or message.created_at
    return InferenceRunOut(
        id=message.id,
        userId=user_id,
        conversationId=message.conversation_id,
        assistantMessageId=message.id,
        parentMessageId=message.parent_message_id,
        status=message.streaming_status or "completed",
        scheduledTaskId=message.scheduled_task_id,
        messagePath=message.streaming_message_path or [],
        content=message.content,
        thinking=message.reasoning_steps,
        rawEvents=message.raw_events or [],
        inputTokens=message.input_tokens,
        outputTokens=message.output_tokens,
        cachedInputTokens=message.cached_input_tokens,
        reasoningTokens=message.reasoning_tokens,
        modelLatencyMs=message.model_latency_ms,
        contextTokens=message.context_tokens,
        contextWindow=message.context_window,
        compactionPercent=message.compaction_percent,
        modelName=message.model_name,
        costMicros=message.cost_micros,
        unpricedCalls=message.unpriced_calls,
        truncatedCalls=message.truncated_calls,
        firstTokenMs=message.first_token_ms,
        ttftMs=message.ttft_ms,
        ttftCalls=message.ttft_calls,
        genMs=message.gen_ms,
        genOutputTokens=message.gen_output_tokens,
        errorMessage=message.error_message,
        startedAt=started,
        completedAt=message.streaming_completed_at,
        cancelRequestedAt=message.streaming_cancel_requested_at,
        updatedAt=message.updated_at,
    )


async def build_run_event_payload(db: AsyncSession, run_id: str, event_type: str) -> dict[str, Any] | None:
    run = await _load_run(db, run_id)
    if not run:
        return None
    # `_load_run` returns a bare MessageTable; reload with attachments eagerly so
    # the wire-side MessageOut serializer doesn't lazy-load mid-coroutine.
    message = await _load_message(db, run.id)
    conversation = await db.get(ConversationTable, run.conversation_id)
    if conversation is not None:
        await db.refresh(conversation, attribute_names=["agent"])
    user_id = conversation.user_id if conversation else ""
    return {
        "type": event_type,
        "run": build_run_out_from_message(run, user_id=user_id).model_dump(mode="json", by_alias=False),
        "message": MessageOut.model_validate(message).model_dump(mode="json", by_alias=False) if message else None,
        "summary": ConversationSummary.model_validate(conversation).model_dump(mode="json", by_alias=False) if conversation else None,
    }
