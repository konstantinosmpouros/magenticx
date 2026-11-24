"""The composer's queued messages (plan 41 §3.6).

While a conversation has an active run, a message the user sends is not
refused: with ``queue_if_busy`` it joins ``conversations.queued_messages`` — a
short list, oldest first — and goes out when that run ends, on the leaf the run
produced. Plain messages are usually read earlier, by the run itself
(steering, ``engine.inference.steering``).

* **A short list.** Up to ``INFERENCE_QUEUE_MAX_MESSAGES`` (5); one more is a
  409 and stays in the composer. Each message has an ``id``;
  ``DELETE …/queued-messages/{id}`` cancels that one.
* **Stacked when sent.** When the run ends, the *leading* plain messages for
  the same agent go out together: each its own user message, one under the
  other, and one answer to all of them. A slash command is a turn of its own,
  and a message for another agent another answer — they wait, in order,
  behind the batch before them, for the answer it starts.
* **Durable.** It is a column, so it survives a bridge restart; the reconcile
  loop sends what a restart (or a missed run-end) left behind.
* **Sent exactly once.** Sending first *claims* the whole list under a row
  lock — the run-end hook, the loop, the queue route and a run's steering
  claim can race, and only one of them gets a message. What is not sent now
  goes back to the front of the list, ahead of anything queued meanwhile.
* **Text, a slash command and a reasoning effort only.** Attachment bytes are
  never parked in a JSON column: a send with attachments to a busy
  conversation gets today's 409.

The composer shows the list through ``queue`` frames on the conversation
channel.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Optional
from uuid import uuid4

from fastapi import HTTPException, status
from sqlalchemy import or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from core.database import ConversationTable, MessageTable, SessionLocal, UserTable
from core.logging import get_logger
from core.settings import settings
from schema import (
    InferenceStartPayload,
    MessageIn,
    QueuedMessageOut,
    QueuedStartResponse,
    queued_items_from_column,
    queued_message_from_item,
    queued_messages_from_column,
)
from engine.agents.catalog import get_agent_by_id
from engine.agents.commands import check_invocation
from engine.conversations.conversations import init_message
from engine.inference.channel import publish_queue, publish_run_started
from engine.inference.runs.state import ACTIVE_RUN_STATUSES
from engine.inference.runs.manager import inference_run_manager
from engine.inference.start import start_inference_flow
from engine.inference.steering import INTERJECTION_KIND, clear_doorbell, ring_doorbell, steerable

logger = get_logger(__name__)

#: Refusals of a queued send that pass: try again when the next run ends.
_TRANSIENT_STATUSES = (status.HTTP_409_CONFLICT, status.HTTP_429_TOO_MANY_REQUESTS)


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


async def active_run_id(db: AsyncSession, conversation_id: str) -> Optional[str]:
    """The conversation's active run (queued / running / cancelling), if any."""
    return await db.scalar(
        select(MessageTable.id)
        .where(
            MessageTable.conversation_id == conversation_id,
            MessageTable.streaming_status.in_(ACTIVE_RUN_STATUSES),
        )
        .limit(1)
    )


async def _owned_chat(db: AsyncSession, user_id: str, conversation_id: str) -> ConversationTable:
    """The caller's ordinary conversation (never a "Try it" trial), locked for the
    queue change that follows, else 404."""
    conversation = (
        await db.execute(
            select(ConversationTable)
            .where(
                ConversationTable.id == conversation_id,
                ConversationTable.user_id == user_id,
                ConversationTable.is_trial.is_(False),
            )
            .with_for_update()
        )
    ).scalar_one_or_none()
    if conversation is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Conversation not found.")
    return conversation


def _wire(items: list[dict[str, Any]]) -> list[QueuedMessageOut]:
    """The stored items' wire shapes (``after_run_id`` is internal and dropped)."""
    return queued_messages_from_column(items)


async def queue_if_busy(
    db: AsyncSession, user: UserTable, payload: InferenceStartPayload
) -> Optional[QueuedStartResponse]:
    """Add ``payload`` to the conversation's queue when it is busy.

    Returns None when the start should go ahead as usual: the flag is off, it
    is not a ``send``, or no run is active. Validated now, not when it is sent,
    so a message that could never run is refused at once: the agent must be
    one the user may use, the command one the agent has.
    """
    if not payload.queue_if_busy or payload.mode != "send" or not payload.conversationId:
        return None
    conversation = await _owned_chat(db, user.id, payload.conversationId)
    running = await active_run_id(db, conversation.id)
    if running is None:
        await db.rollback()
        return None
    message = payload.message
    if message is None or message.sender != "user":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="message is required for this inference mode.")
    if message.attachments:
        # Bytes are never parked in a JSON column; the composer keeps them.
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Conversation already has an active inference run. Files can be sent once it finishes.",
        )
    agent = await get_agent_by_id(payload.agentId) if payload.agentId else None
    if agent is None or (agent.owner_user_id is not None and agent.owner_user_id != user.id):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Unknown or inactive agent.")
    if message.command is not None:
        await check_invocation(db, user.id, agent, message.command)
    if message.canvasEdit is not None:
        # A canvas edit is about one version of a document the active run may
        # be changing right now; it is sent once the run ends, like files.
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Conversation already has an active inference run. A canvas edit can be sent once it finishes.",
        )
    items = queued_items_from_column(conversation.queued_messages)
    cap = settings.inference.queue_max_messages
    if len(items) >= cap:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"You can queue up to {cap} messages while an answer is running.",
        )

    queued = QueuedMessageOut(
        id=uuid4().hex,
        content=message.content,
        command=message.command,
        effort=message.effort,
        agent_id=agent.id,
        queued_at=_now(),
    )
    # after_run_id: the run this message waits for — it is sent on the leaf
    # that run produces. Internal; never part of the wire shape. A new list,
    # not an append in place: the JSON column only sees a reassignment.
    items = [*items, {**queued.model_dump(mode="json"), "after_run_id": running}]
    conversation.queued_messages = items
    await db.commit()
    logger.info("composer_message_queued", "Message queued behind the active run",
                conversation_id=conversation.id, run_id=running, queued=len(items))
    await publish_queue(conversation.id, _wire(items))
    # After the commit, never before: a claim that ran meanwhile cleared the
    # doorbell under the row lock, and this rings it again for the new message.
    if await steerable(db, running, agent_id=agent.id, has_command=message.command is not None):
        await ring_doorbell(running)

    # The run may have ended between the check and the commit, its run-end
    # hook finding nothing queued yet: then this is the moment to send it.
    if await active_run_id(db, conversation.id) is None:
        await send_queued_messages(conversation.id, after_run_id=running, session_factory=_session_factory_of(db))
    return QueuedStartResponse(queued_messages=_wire(items))


def _session_factory_of(db: AsyncSession) -> Callable[[], AsyncSession]:
    """A factory for new sessions on the same database as ``db``."""
    bind = db.bind

    def factory() -> AsyncSession:
        return AsyncSession(bind=bind, expire_on_commit=False)

    return factory


async def cancel_queued_message(db: AsyncSession, user_id: str, conversation_id: str, message_id: str) -> None:
    """``DELETE …/queued-messages/{id}``: drop that one message, 404 when it is gone
    (already sent, read by the run, or cancelled elsewhere)."""
    conversation = await _owned_chat(db, user_id, conversation_id)
    items = queued_items_from_column(conversation.queued_messages)
    kept = [item for item in items if item.get("id") != message_id]
    if len(kept) == len(items):
        await db.rollback()
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Queued message not found.")
    conversation.queued_messages = kept or None
    await db.commit()
    if not kept:
        # Nothing waits any more: the run need not look.
        for run_id in {item.get("after_run_id") for item in items}:
            await clear_doorbell(run_id if isinstance(run_id, str) else None)
    logger.info("composer_message_unqueued", "Queued message cancelled",
                conversation_id=conversation_id, queued=len(kept))
    await publish_queue(conversation_id, _wire(kept))


async def _claim_all(db: AsyncSession, conversation_id: str) -> Optional[tuple[str, list[dict[str, Any]]]]:
    """Take every queued message out of the list: (user id, items), or None.

    The row is locked while it is read and emptied, so of two racing senders
    exactly one gets the messages, and a message queued meanwhile waits for
    the lock and lands in the emptied list.
    """
    row = (
        await db.execute(
            select(ConversationTable.user_id, ConversationTable.queued_messages)
            .where(ConversationTable.id == conversation_id)
            .with_for_update()
        )
    ).first()
    items = queued_items_from_column(row.queued_messages) if row is not None else []
    if not items:
        await db.rollback()
        return None
    await db.execute(
        update(ConversationTable).where(ConversationTable.id == conversation_id).values(queued_messages=None)
    )
    await db.commit()
    # Sent at the run end now: the runs they waited for have nothing left to read.
    for run_id in {item.get("after_run_id") for item in items}:
        await clear_doorbell(run_id if isinstance(run_id, str) else None)
    return row.user_id, items


async def _requeue_front(db: AsyncSession, conversation_id: str, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Put claimed messages back at the front, ahead of anything queued since; the whole list."""
    current = (
        await db.execute(
            select(ConversationTable.queued_messages)
            .where(ConversationTable.id == conversation_id)
            .with_for_update()
        )
    ).scalar_one_or_none()
    merged = [*items, *queued_items_from_column(current)]
    await db.execute(
        update(ConversationTable).where(ConversationTable.id == conversation_id).values(queued_messages=merged or None)
    )
    await db.commit()
    return merged


def next_batch(items: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]], int]:
    """Split the queue into what goes out now and what waits: (batch, rest, dropped).

    The batch is the leading run of plain messages for one agent — or, when
    the first message is a slash command, that command alone (a turn of its
    own). Unreadable items are dropped (and counted).
    """
    readable: list[dict[str, Any]] = []
    dropped = 0
    for item in items:
        if queued_message_from_item(item) is None:
            dropped += 1
        else:
            readable.append(item)
    if not readable:
        return [], [], dropped
    first = readable[0]
    if first.get("command"):
        return [first], readable[1:], dropped
    batch = [first]
    for item in readable[1:]:
        if item.get("command") or item.get("agent_id") != first.get("agent_id"):
            break
        batch.append(item)
    return batch, readable[len(batch):], dropped


async def _parent_for(db: AsyncSession, conversation_id: str, after_run_id: Optional[str]) -> Optional[str]:
    """The leaf the queued messages continue: the run they waited for, if it is
    this conversation's and has ended; else the conversation's newest message."""
    if after_run_id:
        run = await db.get(MessageTable, after_run_id)
        if (
            run is not None
            and run.conversation_id == conversation_id
            and run.streaming_status not in ACTIVE_RUN_STATUSES
        ):
            return run.id
    return await db.scalar(
        select(MessageTable.id)
        .where(
            MessageTable.conversation_id == conversation_id,
            # A message read mid-run is no leaf: it hangs under its answer.
            or_(MessageTable.kind.is_(None), MessageTable.kind != INTERJECTION_KIND),
        )
        .order_by(MessageTable.created_at.desc(), MessageTable.id.desc())
        .limit(1)
    )


def _message_in(item: dict[str, Any]) -> MessageIn:
    """A batch item as the user message it becomes (``next_batch`` keeps readable items only)."""
    queued = queued_message_from_item(item)
    if queued is None:
        raise ValueError("unreadable queued message")
    return MessageIn(sender="user", content=queued.content, command=queued.command, effort=queued.effort)


async def send_queued_messages(
    conversation_id: str,
    *,
    after_run_id: Optional[str] = None,
    session_factory: Optional[Callable[[], AsyncSession]] = None,
) -> bool:
    """Send the queue's next batch now: its messages stacked, then one answer.

    Returns True when a run was started. Called when a run ends (the run-end
    hook), by the reconcile loop, and by the queue route when the run it was
    queued behind ended in the meantime. The messages after the batch go back
    to the front of the queue, now waiting for the answer it starts.
    """
    async with (session_factory or SessionLocal)() as db:
        taken = await _claim_all(db, conversation_id)
        if taken is None:
            return False
        user_id, items = taken
        batch, rest, dropped = next_batch(items)
        if dropped:
            logger.warning("composer_queue_invalid", "Dropped unreadable queued messages",
                           conversation_id=conversation_id, dropped=dropped)
        user = await db.get(UserTable, user_id)
        conversation = await db.get(ConversationTable, conversation_id)
        waited_for = batch[0].get("after_run_id") if batch else None
        parent_id = (
            await _parent_for(db, conversation_id, waited_for if isinstance(waited_for, str) else after_run_id)
            if batch else None
        )
        if user is None or conversation is None or parent_id is None:
            await publish_queue(conversation_id, [])
            return False
        try:
            # Every message but the last is written here, each under the one
            # before; the last goes through the ordinary send, which starts the
            # answer under it. One transaction: a refused start keeps none.
            for item in batch[:-1]:
                stacked = await init_message(db, conversation, _message_in(item), parent_message_id=parent_id)
                parent_id = stacked.id
            await db.flush()
            payload = InferenceStartPayload(
                mode="send",
                agentId=batch[-1].get("agent_id"),
                conversationId=conversation_id,
                parentMessageId=parent_id,
                message=_message_in(batch[-1]),
            )
            response = await start_inference_flow(db=db, user=user, payload=payload)
        except HTTPException as exc:
            await db.rollback()
            if exc.status_code in _TRANSIENT_STATUSES:
                queue = await _requeue_front(db, conversation_id, [*batch, *rest])
                logger.info("composer_queue_deferred", "Queued messages wait for the next run end",
                            conversation_id=conversation_id, status_code=exc.status_code)
                await publish_queue(conversation_id, _wire(queue))
                return False
            queue = await _requeue_front(db, conversation_id, rest) if rest else []
            logger.warning("composer_queue_dropped", "Queued messages could not be sent and were dropped",
                           conversation_id=conversation_id, status_code=exc.status_code, dropped=len(batch))
            await publish_queue(conversation_id, _wire(queue))
            return False
        run_id = response.run.id
        queue: list[dict[str, Any]] = []
        if rest:
            # They now wait for the answer this batch starts.
            queue = await _requeue_front(db, conversation_id, [{**item, "after_run_id": run_id} for item in rest])
    inference_run_manager.launch(run_id)
    logger.info("composer_queue_sent", "Queued messages sent", conversation_id=conversation_id,
                run_id=run_id, stacked=len(batch), still_queued=len(queue))
    await publish_queue(conversation_id, _wire(queue))
    await publish_run_started(response.run, from_queue=True)
    if rest:
        async with (session_factory or SessionLocal)() as db:
            first = rest[0]
            if await steerable(db, run_id, agent_id=str(first.get("agent_id")), has_command=bool(first.get("command"))):
                await ring_doorbell(run_id)
    return True


async def pending_queue_conversations(
    db: AsyncSession, *, older_than_seconds: int, limit: int = 100
) -> list[str]:
    """Conversations holding queued messages and no active run — what a
    restart or a missed run-end left behind (the reconcile loop sends them)."""
    rows = (
        await db.execute(
            select(ConversationTable.id, ConversationTable.queued_messages)
            .where(ConversationTable.queued_messages.is_not(None))
            .limit(limit)
        )
    ).all()
    cutoff = _now() - timedelta(seconds=older_than_seconds)
    due: list[str] = []
    for conversation_id, value in rows:
        items = queued_items_from_column(value)
        if not items:
            continue
        queued = queued_message_from_item(items[-1])
        queued_at = queued.queued_at if queued is not None else None
        if queued_at is not None:
            if queued_at.tzinfo is not None:
                queued_at = queued_at.astimezone(timezone.utc).replace(tzinfo=None)
            if queued_at > cutoff:
                continue  # just queued: its run-end hook will send it
        if await active_run_id(db, conversation_id) is None:
            due.append(conversation_id)
    return due
