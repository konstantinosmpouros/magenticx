"""Steering: the run reads the messages the user sent while it worked (SSE plan, phase 5).

Messages sent to a busy conversation join the composer's queue
(``engine.inference.composer_queue``, ``conversations.queued_messages``) and,
before this, were only ever sent when the run ended. Now the run itself can
take them at its next step boundary — the agents service's
``SteeringMiddleware``, just before a model call — so the user can correct or
add to a task while it is under way.

* **The queue stays the record.** Nothing new is stored: messages are queued
  exactly as before, and whatever takes one out of the list owns it.
* **A doorbell says "look".** Queuing a message behind run ``R`` also sets the
  Redis key ``run:{R}:steer`` (:func:`ring_doorbell`). The agent checks it
  before each model call — one ``EXISTS`` — and only then calls the claim
  endpoint, so a run with nothing waiting never touches this database.
* **Exactly once, in order.** :func:`claim_interjection` takes the leading
  messages under the same row lock as the run-end send
  (``composer_queue._claim_all``): of the run reading one and the run end
  sending it, exactly one gets it. A message is read only when it was queued
  behind *this* run, is plain text (a slash command needs a turn of its own)
  and is for the agent that runs; the first one that is not ends the claim,
  so it and everything after it wait, in order, for the run end.
* **Each is kept as its own message.** The claim writes a ``messages`` row per
  message — sender ``user``, ``kind = 'interjection'``, parented on the
  answer that read it — in the same transaction that takes it off the list,
  so it is saved exactly once. Not a turn of the branch tree
  (``ConversationTable.messages`` leaves it out); search, embeddings and the
  export read ``messages`` directly and find it, and the history the agent is
  sent puts it before that answer (``engine.inference.history``).
* **The doorbell is cleared under the lock** whenever a claim finds nothing for
  this run, and the queue sets it only *after* its commit — so a message
  queued during a claim always leaves the doorbell rung.

Redis failures are logged and swallowed: a missed doorbell only means the
messages are sent when the run ends, which is the old behaviour.
"""
from __future__ import annotations

import asyncio
from typing import Optional

import redis.asyncio as aioredis
from fastapi import HTTPException, status
from redis.exceptions import RedisError
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from core.cache import create_redis_client
from core.database import ConversationTable, MessageTable
from core.logging import get_logger
from core.settings import settings
from engine.inference.channel import publish_queue
from engine.inference.runs.state import ACTIVE_RUN_STATUSES
from schema import (
    InterjectionOut,
    QueuedMessageOut,
    queued_items_from_column,
    queued_message_from_item,
    queued_messages_from_column,
)

logger = get_logger(__name__)

#: ``messages.kind`` of a message the user sent while a run worked.
INTERJECTION_KIND = "interjection"


def steer_key(run_id: str) -> str:
    """The doorbell for ``run_id``; the agents service reads the same key."""
    return f"run:{run_id}:steer"


class SteerDoorbell:
    """The ``run:{id}:steer`` keys. Every method is best effort and never raises.

    A holder with a lazily opened client, like the event log and the channel,
    so tests point it at their in-process Redis the same way.
    """

    def __init__(self) -> None:
        self._client: aioredis.Redis | None = None
        self._lock = asyncio.Lock()

    async def _get_client(self) -> aioredis.Redis:
        if self._client is not None:
            return self._client
        async with self._lock:
            if self._client is None:
                self._client = create_redis_client()
        return self._client

    async def ring(self, run_id: str) -> None:
        """Tell ``run_id`` a message waits for it."""
        try:
            client = await self._get_client()
            await client.set(steer_key(run_id), "1", ex=settings.inference.steer_doorbell_ttl_seconds)
        except (RedisError, OSError) as exc:
            logger.warning("steer_doorbell_failed", "Could not ring the run's doorbell; the message is sent at run end",
                           run_id=run_id, error_type=type(exc).__name__)

    async def clear(self, run_id: Optional[str]) -> None:
        """Nothing waits for ``run_id`` any more."""
        if not run_id:
            return
        try:
            client = await self._get_client()
            await client.delete(steer_key(run_id))
        except (RedisError, OSError) as exc:
            logger.warning("steer_doorbell_clear_failed", "Could not clear the run's doorbell",
                           run_id=run_id, error_type=type(exc).__name__)

    async def is_rung(self, run_id: str) -> bool:
        """Whether a message waits for ``run_id`` (False when Redis cannot say)."""
        try:
            client = await self._get_client()
            return bool(await client.exists(steer_key(run_id)))
        except (RedisError, OSError):
            return False


steer_doorbell = SteerDoorbell()


async def ring_doorbell(run_id: str) -> None:
    """Tell ``run_id`` a message waits for it. Never raises."""
    await steer_doorbell.ring(run_id)


async def clear_doorbell(run_id: Optional[str]) -> None:
    """Nothing waits for ``run_id`` any more. Never raises."""
    await steer_doorbell.clear(run_id)


async def steerable(db: AsyncSession, run_id: str, *, agent_id: str, has_command: bool) -> bool:
    """Whether a message queued behind ``run_id`` may be read by that run.

    Plain text only (a slash command is a turn of its own), and only for the
    agent that runs: a message for another agent waits for the run end.
    """
    if has_command:
        return False
    run_agent = await db.scalar(select(MessageTable.agent_id).where(MessageTable.id == run_id))
    return run_agent is not None and run_agent == agent_id


async def claim_interjection(
    db: AsyncSession, *, conversation_id: str, user_id: str, run_id: str
) -> list[InterjectionOut]:
    """Hand the messages waiting behind ``run_id`` to that run, oldest first.

    The *leading* queued messages it may read: queued behind this run, plain
    text, for the agent that runs — the first one that is not (a slash
    command, another agent's) ends the claim, so the messages after it keep
    their order behind it. Each is saved as its own ``interjection`` row under
    the answer. 404 when the conversation is not the user's; ``[]`` — and the
    doorbell cleared — when there is nothing for this run to read now.
    """
    row = (
        await db.execute(
            select(ConversationTable.user_id, ConversationTable.queued_messages)
            .where(ConversationTable.id == conversation_id)
            .with_for_update()
        )
    ).first()
    if row is None or row.user_id != user_id:
        await db.rollback()
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Conversation not found.")

    items = queued_items_from_column(row.queued_messages)
    run = await db.get(MessageTable, run_id) if items else None
    run_is_live = (
        run is not None and run.conversation_id == conversation_id and run.streaming_status in ACTIVE_RUN_STATUSES
    )
    claimed: list[tuple[dict, QueuedMessageOut]] = []
    for item in items if run_is_live else []:
        queued = queued_message_from_item(item)
        readable = (
            queued is not None
            and item.get("after_run_id") == run_id
            and bool((queued.content or "").strip())
            and await steerable(db, run_id, agent_id=queued.agent_id, has_command=queued.command is not None)
        )
        if not readable:
            break
        claimed.append((item, queued))
    if not claimed:
        # Still under the row lock: a message queued meanwhile commits after
        # this and rings again, so clearing here never loses one.
        await clear_doorbell(run_id)
        await db.rollback()
        return []

    rest = items[len(claimed):]
    await db.execute(
        update(ConversationTable)
        .where(ConversationTable.id == conversation_id)
        .values(queued_messages=rest or None)
    )
    for _item, queued in claimed:
        db.add(MessageTable(
            conversation_id=conversation_id,
            parent_message_id=run_id,
            sender="user",
            kind=INTERJECTION_KIND,
            content=queued.content or "",
        ))
    await clear_doorbell(run_id)
    await db.commit()
    logger.info("steering_message_claimed", "A run read the messages sent while it worked",
                conversation_id=conversation_id, run_id=run_id, claimed=len(claimed), still_queued=len(rest))
    await publish_queue(conversation_id, queued_messages_from_column(rest))
    return [InterjectionOut(content=queued.content or "", queued_at=queued.queued_at) for _item, queued in claimed]


async def interjections_by_answer(db: AsyncSession, answer_ids: list[str]) -> dict[str, list[MessageTable]]:
    """The messages the user sent while each of these answers ran, oldest first, by answer id."""
    if not answer_ids:
        return {}
    rows = (
        await db.execute(
            select(MessageTable)
            # Loaded with them, as the history serialiser reads them (none, today).
            .options(selectinload(MessageTable.attachments))
            .where(MessageTable.parent_message_id.in_(answer_ids), MessageTable.kind == INTERJECTION_KIND)
            .order_by(MessageTable.created_at.asc(), MessageTable.id.asc())
        )
    ).scalars().all()
    out: dict[str, list[MessageTable]] = {}
    for row in rows:
        out.setdefault(row.parent_message_id, []).append(row)
    return out


async def carry_interjections(db: AsyncSession, *, from_answer_id: str, to_answer_id: str) -> int:
    """A retry answers everything the user said: copy what they sent while the
    retried answer ran onto the new answer, which reads it as its input
    (``engine.inference.runs.manager``). Returns how many were carried."""
    carried = (await interjections_by_answer(db, [from_answer_id])).get(from_answer_id, [])
    for row in carried:
        db.add(MessageTable(
            conversation_id=row.conversation_id,
            parent_message_id=to_answer_id,
            sender="user",
            kind=INTERJECTION_KIND,
            content=row.content,
        ))
    return len(carried)


__all__ = [
    "INTERJECTION_KIND",
    "SteerDoorbell",
    "carry_interjections",
    "interjections_by_answer",
    "claim_interjection",
    "clear_doorbell",
    "ring_doorbell",
    "steer_doorbell",
    "steer_key",
    "steerable",
]
