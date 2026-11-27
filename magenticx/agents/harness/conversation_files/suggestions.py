"""The user's pending suggestions on a canvas document (plan 44, Phase 4.6 — Suggesting mode).

In the canvas's **Suggesting** mode what the user types and deletes does not
change the document: it becomes suggestions (tracked changes) the user later
accepts or rejects. The pending set of one document is stored as one row of
``conversation_file_suggestions``: the **proposed** full markdown (the text
with every pending suggestion accepted) and the accepted version it was made
on (``base_version``). The UI rebuilds the individual suggestions as the diff
base → proposed, so one row is the whole set and a save is one upsert.

Rules, all here so the routes and the turn note cannot disagree:

* the path is a canvas document's (the caller canonicalises it with
  :func:`~harness.conversation_files.versions.document_path`) and the base
  version must exist for it in this conversation — read, decrypted, in the
  same transaction as the write; the foreign key to the versions is the
  backstop (:class:`DocumentNotFound` otherwise);
* the proposed text is bounded like a version (:data:`MAX_DOCUMENT_BYTES`);
* a proposed text equal to the base's is "nothing suggested": the row is
  deleted instead of written (:meth:`DocumentSuggestionStore.put` returns None);
* the content is the user's words, so it is encrypted with the blobs' cipher
  (:mod:`.cipher`), the cipher's name kept beside it.

No lock is needed: a version is append-only (the base read cannot change
under the write) and the row is replaced whole by one upsert, so two tabs
saving at once end with the later one — the same last-write-wins as the
user's own unsaved draft. Accepting is not a write here: the UI saves the
accepted text as a normal user version and then deletes (or rewrites) the set.

The agent reads the pending sets once per turn (:meth:`pending`, rendered by
:mod:`harness.canvas.notes` as ``<canvas_suggestions>``). It never writes one;
when — and only when — the user asks, its ``review_suggestions`` tool
(:mod:`harness.tools.canvas_suggestions`) accepts a set (writes the proposed
text into the document's file, as its own edit, then drops the set with
:meth:`delete` scoped to the set it applied) or rejects it (:meth:`delete`).
The DDL lives in :mod:`.store` beside the versions the rows name; its fork
copy, reap and purge include them.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any

from core.logging import get_logger
from harness.conversation_files.versions import (
    MAX_DOCUMENT_BYTES,
    DocumentNotFound,
    DocumentTooLarge,
    DocumentVersionStore,
)

logger = get_logger(__name__)

#: How many documents' pending sets one turn's note reads, at most. The note's
#: own character caps (``harness.canvas.notes``) are far tighter; this bounds
#: the query and the decryption.
TURN_MAX_DOCUMENTS = 10

_SCOPE = (
    "conversation_id = %(conversation_id)s AND branch_thread_id = %(branch)s AND user_id = %(user_id)s"
)


@dataclass(frozen=True)
class DocumentSuggestion:
    """A document's pending suggestion set: the proposed text on its base version."""

    path: str
    base_version: int
    content: str
    updated_at: datetime


@dataclass(frozen=True)
class PendingSuggestion:
    """One document's pending set as the turn's note needs it: base text, proposed text, where it stands now."""

    path: str
    base_version: int
    #: The document's latest version now — past ``base_version`` when the agent edited meanwhile.
    latest_version: int
    base_text: str
    proposed_text: str


@dataclass(frozen=True)
class PendingSuggestions:
    """What one turn read: the newest pending sets, and how many the conversation has in all."""

    documents: list[PendingSuggestion]
    total: int


def _text(data: bytes) -> str:
    """Stored bytes as text; invalid UTF-8 shows the replacement character rather than failing."""
    return data.decode("utf-8", errors="replace")


class DocumentSuggestionStore(DocumentVersionStore):
    """The pending suggestion sets of one user's canvas documents.

    A subclass of the version store for its pool, its cipher and its
    decrypting version reader. Every statement filters on ``conversation_id``,
    the store's branch and ``user_id``; paths are expected canonical.
    """

    def _suggestion(self, row: dict[str, Any]) -> DocumentSuggestion:
        return DocumentSuggestion(
            path=row["path"],
            base_version=int(row["base_version"]),
            content=_text(self._cipher.decrypt(row["cipher"], bytes(row["content"]))),
            updated_at=row["updated_at"],
        )

    # -- reads ---------------------------------------------------------------
    async def get(self, user_id: str, conversation_id: str, path: str) -> DocumentSuggestion | None:
        """The document's pending set, or None when it has none."""
        async with self._connect(user_id, conversation_id) as conn:
            cur = await conn.execute(
                "SELECT path, base_version, cipher, content, updated_at FROM conversation_file_suggestions "
                f"WHERE {_SCOPE} AND path = %(path)s",
                {"user_id": user_id, "conversation_id": conversation_id, "path": path},
            )
            row = await cur.fetchone()
        return self._suggestion(row) if row is not None else None

    async def pending(self, user_id: str, conversation_id: str) -> PendingSuggestions:
        """The conversation's pending sets for the turn's note, most recently saved first.

        **One statement**: at most :data:`TURN_MAX_DOCUMENTS` sets, each with
        its base version's text (the blob the version names) and the
        document's latest version number, plus the total. Read-only.
        """
        async with self._connect(user_id, conversation_id) as conn:
            cur = await conn.execute(
                "SELECT s.path, s.base_version, s.cipher, s.content, b.cipher AS base_cipher, b.data AS base_data, "
                "(SELECT max(l.version) FROM conversation_file_versions l "
                "WHERE l.conversation_id = s.conversation_id AND l.branch_thread_id = s.branch_thread_id "
                "AND l.user_id = s.user_id AND l.path = s.path) "
                "AS latest_version, count(*) OVER () AS total "
                "FROM conversation_file_suggestions s "
                "JOIN conversation_file_versions v ON v.conversation_id = s.conversation_id "
                "AND v.branch_thread_id = s.branch_thread_id "
                "AND v.path = s.path AND v.version = s.base_version AND v.user_id = s.user_id "
                "JOIN conversation_file_blobs b ON b.user_id = v.user_id AND b.sha256 = v.sha256 "
                "WHERE s.conversation_id = %(conversation_id)s AND s.branch_thread_id = %(branch)s "
                "AND s.user_id = %(user_id)s "
                "ORDER BY s.updated_at DESC, s.path LIMIT %(limit)s",
                {"user_id": user_id, "conversation_id": conversation_id, "limit": TURN_MAX_DOCUMENTS},
            )
            rows = await cur.fetchall()
        documents = [
            PendingSuggestion(
                path=row["path"],
                base_version=int(row["base_version"]),
                latest_version=int(row["latest_version"] or row["base_version"]),
                base_text=_text(self._cipher.decrypt(row["base_cipher"], bytes(row["base_data"]))),
                proposed_text=_text(self._cipher.decrypt(row["cipher"], bytes(row["content"]))),
            )
            for row in rows
        ]
        return PendingSuggestions(documents=documents, total=int(rows[0]["total"]) if rows else 0)

    # -- writes --------------------------------------------------------------
    async def put(
        self, user_id: str, conversation_id: str, path: str, *, base_version: int, content: str
    ) -> DocumentSuggestion | None:
        """Save the document's pending set: ``content`` proposed on ``base_version``.

        Returns the saved set, or None when ``content`` equals the base
        version's text — nothing is suggested, so the row is deleted instead.
        :class:`DocumentTooLarge` over the cap; :class:`DocumentNotFound` when
        the conversation has no such version of the document.
        """
        data = content.encode("utf-8")
        if len(data) > MAX_DOCUMENT_BYTES:
            raise DocumentTooLarge(path)
        scope = {"user_id": user_id, "conversation_id": conversation_id, "path": path}
        async with self._connect(user_id, conversation_id) as conn, conn.transaction():
            base = await self._read_version(conn, user_id, conversation_id, path, base_version)
            if base is None:
                raise DocumentNotFound(path)
            if base.content == content:
                await conn.execute(f"DELETE FROM conversation_file_suggestions WHERE {_SCOPE} AND path = %(path)s",
                                   scope)
                saved = None
            else:
                cipher, sealed = self._cipher.encrypt(data)
                cur = await conn.execute(
                    "INSERT INTO conversation_file_suggestions "
                    "(conversation_id, branch_thread_id, path, user_id, base_version, cipher, content, size_bytes) "
                    "VALUES (%(conversation_id)s, %(branch)s, %(path)s, %(user_id)s, %(base)s, %(cipher)s, "
                    "%(content)s, %(size)s) "
                    "ON CONFLICT (conversation_id, branch_thread_id, path) DO UPDATE SET "
                    "base_version = EXCLUDED.base_version, "
                    "cipher = EXCLUDED.cipher, content = EXCLUDED.content, size_bytes = EXCLUDED.size_bytes, "
                    "updated_at = now() "
                    # Belt and braces: a row is only ever replaced by its own user.
                    "WHERE conversation_file_suggestions.user_id = EXCLUDED.user_id "
                    "RETURNING path, base_version, cipher, content, updated_at",
                    {**scope, "base": base_version, "cipher": cipher, "content": sealed, "size": len(data)},
                )
                row = await cur.fetchone()
                if row is None:
                    raise DocumentNotFound(path)
                saved = self._suggestion(row)
        logger.info("document_suggestion_saved", "Saved the user's pending suggestions on a canvas document",
                    base_version=base_version, size_bytes=len(data), cleared=saved is None)
        return saved

    async def delete(
        self, user_id: str, conversation_id: str, path: str, *, saved_at: datetime | None = None
    ) -> bool:
        """Drop the document's pending set. Idempotent: False when there was none.

        ``saved_at`` (the ``updated_at`` of a set the caller read) drops only
        that very set: the agent's accept applied the text it read, so a set
        the user saved again in the meantime is theirs to keep.
        """
        only_that = " AND updated_at = %(saved_at)s" if saved_at is not None else ""
        async with self._connect(user_id, conversation_id) as conn:
            cur = await conn.execute(
                f"DELETE FROM conversation_file_suggestions WHERE {_SCOPE} AND path = %(path)s{only_that}",
                {"user_id": user_id, "conversation_id": conversation_id, "path": path, "saved_at": saved_at},
            )
            deleted = bool(cur.rowcount)
        logger.info("document_suggestion_deleted", "Dropped the user's pending suggestions on a canvas document",
                    deleted=deleted)
        return deleted


__all__ = [
    "TURN_MAX_DOCUMENTS",
    "DocumentSuggestion",
    "DocumentSuggestionStore",
    "PendingSuggestion",
    "PendingSuggestions",
]
