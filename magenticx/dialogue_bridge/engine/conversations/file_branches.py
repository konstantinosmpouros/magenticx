"""Which branch of a conversation a call about its files is for.

The agents service keeps a conversation's files, canvas documents, comments
and suggestions per **branch**: the checkpoint thread the branch's answers run
on (``messages.checkpoint_thread_id``). The browser never names a thread; it
names a message it shows (the answer a document belongs to, or the last one of
the branch on screen), and the bridge resolves the branch here — the nearest
answer at or above that message that has a thread. That answer is also the one
a user's save is recorded under, so a later fork cuts the save where it was
made.

A message with no such answer above it (a conversation from before branch
threads) resolves to the **legacy** branch ``""``: the files the agents
service kept from before branches.
"""
from __future__ import annotations

from dataclasses import dataclass

from fastapi import Depends, HTTPException, Query, status
from sqlalchemy import literal, select
from sqlalchemy.ext.asyncio import AsyncSession

from core.database import MessageTable, get_db

#: The agents service's branch for rows written before branches.
LEGACY_BRANCH = ""


@dataclass(frozen=True)
class FileBranch:
    """A branch's checkpoint thread, and the answer a write on it belongs to."""

    thread_id: str
    message_id: str | None = None

    def params(self) -> dict[str, str]:
        """The query parameters every agents-service file route takes."""
        params = {"branch_thread_id": self.thread_id}
        if self.message_id:
            params["message_id"] = self.message_id
        return params


def run_file_branch(run: MessageTable) -> FileBranch:
    """The branch a run wrote its files on: its own thread, under its own id."""
    return FileBranch(thread_id=run.checkpoint_thread_id or LEGACY_BRANCH, message_id=str(run.id))


def branch_of_path(path: list[MessageTable]) -> FileBranch:
    """The branch of a path of messages (root first): its last answer that has a thread."""
    for message in reversed(path):
        if message.sender == "ai" and message.checkpoint_thread_id:
            return FileBranch(thread_id=message.checkpoint_thread_id, message_id=str(message.id))
    return FileBranch(thread_id=LEGACY_BRANCH)


async def resolve_file_branch(db: AsyncSession, conversation_id: str, message_id: str) -> FileBranch:
    """The branch ``message_id`` is on: the nearest answer at or above it that has a thread.

    One recursive walk up ``parent_message_id``, held to the conversation at
    every step. 404 when the message is not in the conversation.
    """
    walk = (
        select(
            MessageTable.id, MessageTable.parent_message_id, MessageTable.sender,
            MessageTable.checkpoint_thread_id, literal(0).label("depth"),
        )
        .where(MessageTable.id == message_id, MessageTable.conversation_id == conversation_id)
        .cte("file_branch_walk", recursive=True)
    )
    walk = walk.union_all(
        select(
            MessageTable.id, MessageTable.parent_message_id, MessageTable.sender,
            MessageTable.checkpoint_thread_id, (walk.c.depth + 1).label("depth"),
        )
        .join(walk, MessageTable.id == walk.c.parent_message_id)
        .where(MessageTable.conversation_id == conversation_id)
    )
    rows = (await db.execute(
        select(walk.c.id, walk.c.sender, walk.c.checkpoint_thread_id).order_by(walk.c.depth)
    )).all()
    if not rows:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Message not found.")
    for row_id, sender, thread_id in rows:
        if sender == "ai" and thread_id:
            return FileBranch(thread_id=thread_id, message_id=str(row_id))
    return FileBranch(thread_id=LEGACY_BRANCH)


async def document_branch(
    conversation_id: str,
    messageId: str = Query(min_length=1, max_length=64,
                           description="A message of the branch on screen; its files are the ones read or written."),
    db: AsyncSession = Depends(get_db),
) -> FileBranch:
    """The route dependency: the branch of the message the UI names, in the path's conversation.

    Runs beside ``validate_convId`` (the conversation is the caller's); the
    walk is held to that conversation, so a message from another one is a 404.
    """
    return await resolve_file_branch(db, conversation_id, messageId)


__all__ = [
    "LEGACY_BRANCH",
    "FileBranch",
    "branch_of_path",
    "document_branch",
    "resolve_file_branch",
    "run_file_branch",
]
