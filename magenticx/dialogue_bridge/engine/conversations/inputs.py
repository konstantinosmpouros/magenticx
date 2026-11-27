"""A conversation's uploads, served to the agents service (plan 36).

The agent's ``/conversation/input/`` folder is a view of these rows — nothing is
copied to the agents service any more. It lists the uploads of the run's
branch, under the stable name assigned at upload (``attachments.workspace_name``),
and reads one when the agent opens it.

**One branch only.** The run names the message it answers (its own answer
message); only uploads on that message's path to the root count. An edit or a
retry that leaves a file behind starts a branch whose agent cannot open it, and
a file on a sibling branch is not there either — the agent sees the files the
history it reads shows.

Every query is scoped to the conversation *and* its owner, so a wrong id from
the caller finds nothing rather than someone else's file.
"""
from __future__ import annotations

from sqlalchemy import Select, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from core.database import AttachmentTable, BlobTable, ConversationTable, MessageTable


def _branch_path(conversation_id: str, message_id: str):
    """The ids of ``message_id`` and every message above it, up to the root.

    A recursive walk up ``parent_message_id``, held to the conversation at
    every step, so an id from another conversation yields nothing.
    """
    path = (
        select(MessageTable.id, MessageTable.parent_message_id)
        .where(MessageTable.id == message_id, MessageTable.conversation_id == conversation_id)
        .cte("branch_path", recursive=True)
    )
    parent = select(MessageTable.id, MessageTable.parent_message_id).join(
        path, MessageTable.id == path.c.parent_message_id
    ).where(MessageTable.conversation_id == conversation_id)
    return path.union_all(parent)


def _owned_uploads(conversation_id: str, user_id: str, message_id: str, *columns) -> Select:
    """The uploads on ``message_id``'s branch of a conversation ``user_id`` owns.

    Only real uploads that were given a name and a hash: the agent's own
    output is not an input.
    """
    path = _branch_path(conversation_id, message_id)
    return (
        select(*columns)
        .select_from(AttachmentTable)
        .join(MessageTable, AttachmentTable.message_id == MessageTable.id)
        .join(ConversationTable, MessageTable.conversation_id == ConversationTable.id)
        .join(BlobTable, AttachmentTable.blob_id == BlobTable.id)
        .where(
            ConversationTable.id == conversation_id,
            ConversationTable.user_id == user_id,
            AttachmentTable.origin == "upload",
            AttachmentTable.workspace_name.is_not(None),
            AttachmentTable.content_sha256.is_not(None),
            AttachmentTable.message_id.in_(select(path.c.id)),
        )
    )


async def conversation_is_owned(db: AsyncSession, conversation_id: str, user_id: str) -> bool:
    found = await db.scalar(
        select(ConversationTable.id).where(
            ConversationTable.id == conversation_id, ConversationTable.user_id == user_id
        )
    )
    return found is not None


async def list_input_files(
    db: AsyncSession, conversation_id: str, user_id: str, message_id: str
) -> list[dict[str, object]]:
    """The uploads of ``message_id``'s branch, one entry per name, oldest upload
    first — the same bytes sent twice share a name, so the list never shows a
    file twice."""
    rows = await db.execute(
        _owned_uploads(
            conversation_id,
            user_id,
            message_id,
            AttachmentTable.id,
            AttachmentTable.workspace_name,
            AttachmentTable.mime_type,
            AttachmentTable.content_sha256,
            AttachmentTable.created_at,
            func.length(BlobTable.data),
        ).order_by(AttachmentTable.created_at, AttachmentTable.id)
    )
    files: dict[str, dict[str, object]] = {}
    for attachment_id, name, mime, sha256, created_at, size in rows.all():
        files.setdefault(name, {
            "name": name,
            "attachment_id": attachment_id,
            "mime": mime,
            "size": int(size or 0),
            "sha256": sha256,
            "created_at": created_at.isoformat() if created_at else None,
        })
    return sorted(files.values(), key=lambda entry: str(entry["name"]))


async def read_input_file(
    db: AsyncSession, conversation_id: str, user_id: str, message_id: str, attachment_id: str
) -> bytes | None:
    """One upload's bytes, only if it is on ``message_id``'s branch."""
    data = await db.scalar(
        _owned_uploads(conversation_id, user_id, message_id, BlobTable.data).where(AttachmentTable.id == attachment_id)
    )
    return bytes(data) if data is not None else None
