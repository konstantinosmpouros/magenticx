"""Comments on a canvas document (plan 44, Phase 4.4).

The user marks a passage of a document and leaves a comment on it — a
*thread* — and may reply under it; a thread is ``open`` until someone
resolves it. ``conversation_file_comments`` holds both, one row each:

* a **thread** has ``parent_id`` NULL, an ``anchor`` (the quoted passage and a
  little text either side, so the UI can find it again after edits) and a
  ``status``;
* a **reply** names its thread in ``parent_id`` — one level only — and has
  neither anchor nor status.

Each comment records the document ``version`` it was made on; the foreign key
to the versions means a comment can only name a document (and a version) the
conversation has. The body, the anchor and the resolution note are the user's
words, so they are encrypted with the blobs' cipher (:mod:`.cipher`), like the
document text they talk about.

Limits, checked under a per-document advisory lock so two tabs cannot both
take the last slot: :data:`MAX_THREADS_PER_DOCUMENT` threads per document and
:data:`MAX_REPLIES_PER_THREAD` replies per thread.

The agent reads the **open** threads at the start of each turn
(:meth:`DocumentCommentStore.open_threads`, rendered by
:mod:`harness.canvas.notes`). v1 has no tool to resolve one; the
``author = 'agent'`` and ``resolved_by = 'agent'`` values are there for v2.

The DDL lives in :mod:`.store`, beside the versions the comments name; its
fork copy, reap and purge include them.
"""
from __future__ import annotations

import json
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Literal

from core.logging import get_logger
from harness.conversation_files.versions import DocumentNotFound, DocumentVersionStore

logger = get_logger(__name__)

CommentAuthor = Literal["agent", "user"]
CommentStatus = Literal["open", "resolved"]

#: Threads (open or resolved) one document may hold.
MAX_THREADS_PER_DOCUMENT = 200
#: Replies under one thread.
MAX_REPLIES_PER_THREAD = 50
#: A comment's body, in characters.
MAX_BODY_CHARS = 4000
#: The anchor's quoted passage, and the context kept either side of it.
MAX_QUOTE_CHARS = 2000
MAX_CONTEXT_CHARS = 200
#: A resolution note (v2: the agent's "done — shortened it").
MAX_RESOLUTION_NOTE_CHARS = 1000
#: Every comment of one document: the threads and all their replies.
MAX_COMMENTS_PER_DOCUMENT = MAX_THREADS_PER_DOCUMENT * (1 + MAX_REPLIES_PER_THREAD)

#: What one turn's note reads, at most: documents with open threads, the
#: newest threads of each, the first replies of each thread. The note's own
#: character caps (``harness.canvas.notes``) are far tighter; these only
#: bound the query and the decryption.
TURN_MAX_DOCUMENTS = 10
TURN_MAX_THREADS = 20
TURN_MAX_REPLIES = 10

_SCOPE = "conversation_id = %(conversation_id)s AND user_id = %(user_id)s"
_COLUMNS = (
    "id, path, version, parent_id, cipher, anchor, body, author, status, resolved_by, "
    "resolution_note, created_at, updated_at"
)


class CommentNotFound(LookupError):
    """No such comment (or reply target) in this conversation."""


class InvalidComment(ValueError):
    """A comment of the wrong shape: a reply to a reply, a status on a reply,
    an edit of someone else's comment, an empty body, an over-long field."""

    code = "invalid_comment"


class CommentLimitReached(InvalidComment):
    """The document has its maximum of threads, or the thread its maximum of replies."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class CommentAnchor:
    """Where a thread sits: the quoted passage and a little text either side of it."""

    quote: str
    prefix: str = ""
    suffix: str = ""


@dataclass(frozen=True)
class DocumentComment:
    """One comment (a thread or a reply), decrypted."""

    id: str
    path: str
    version: int
    parent_id: str | None
    anchor: CommentAnchor | None
    body: str
    author: CommentAuthor
    status: CommentStatus | None
    resolved_by: CommentAuthor | None
    resolution_note: str | None
    created_at: datetime
    updated_at: datetime


@dataclass(frozen=True)
class OpenThread:
    """An open thread as the turn's note shows it: its passage, its comment, its replies."""

    quote: str
    body: str
    author: CommentAuthor
    replies: list[tuple[CommentAuthor, str]] = field(default_factory=list)
    #: Replies past :data:`TURN_MAX_REPLIES`, not read.
    more_replies: int = 0


@dataclass(frozen=True)
class DocumentOpenThreads:
    """One document's open threads for the turn's note, oldest first."""

    path: str
    threads: list[OpenThread]
    #: Every open thread of the document, including those past :data:`TURN_MAX_THREADS`.
    open_total: int


def _comment_id(value: str) -> str:
    """A comment id in canonical form; a malformed one names no comment."""
    try:
        return str(uuid.UUID(str(value)))
    except ValueError as exc:
        raise CommentNotFound(str(value)) from exc


def _check_body(body: str) -> None:
    if not body.strip():
        raise InvalidComment("A comment needs some text.")
    if len(body) > MAX_BODY_CHARS:
        raise InvalidComment(f"A comment is at most {MAX_BODY_CHARS} characters.")


def _check_anchor(anchor: CommentAnchor) -> None:
    if not anchor.quote.strip() or len(anchor.quote) > MAX_QUOTE_CHARS:
        raise InvalidComment(f"A comment quotes 1 to {MAX_QUOTE_CHARS} characters of the document.")
    if len(anchor.prefix) > MAX_CONTEXT_CHARS or len(anchor.suffix) > MAX_CONTEXT_CHARS:
        raise InvalidComment(f"The text around a quote is at most {MAX_CONTEXT_CHARS} characters.")


class DocumentCommentStore(DocumentVersionStore):
    """The comments of one user's canvas documents.

    A subclass of the version store for its pool, its cipher and its
    conventions: every statement filters on both ``conversation_id`` and
    ``user_id``. Paths are expected canonical
    (:func:`~harness.conversation_files.versions.document_path`).
    """

    # -- encryption ----------------------------------------------------------
    def _seal(self, text: str) -> tuple[str, bytes]:
        return self._cipher.encrypt(text.encode("utf-8"))

    def _open(self, cipher: str, data: Any) -> str:
        return self._cipher.decrypt(cipher, bytes(data)).decode("utf-8", errors="replace")

    def _comment(self, row: dict[str, Any]) -> DocumentComment:
        anchor = None
        if row["anchor"] is not None:
            raw = json.loads(self._open(row["cipher"], row["anchor"]))
            anchor = CommentAnchor(quote=str(raw.get("quote", "")), prefix=str(raw.get("prefix", "")),
                                   suffix=str(raw.get("suffix", "")))
        note = row["resolution_note"]
        return DocumentComment(
            id=str(row["id"]),
            path=row["path"],
            version=int(row["version"]),
            parent_id=str(row["parent_id"]) if row["parent_id"] is not None else None,
            anchor=anchor,
            body=self._open(row["cipher"], row["body"]),
            author=row["author"],
            status=row["status"],
            resolved_by=row["resolved_by"],
            resolution_note=self._open(row["cipher"], note) if note is not None else None,
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )

    # -- reads ---------------------------------------------------------------
    async def list_comments(self, user_id: str, conversation_id: str, path: str) -> list[DocumentComment]:
        """Every comment of a document — threads and replies, resolved too — oldest first.

        Empty for a document without comments (or one the conversation does
        not have). Bounded by the limits, so at most
        :data:`MAX_COMMENTS_PER_DOCUMENT` rows.
        """
        async with self._pool.connection() as conn:
            cur = await conn.execute(
                f"SELECT {_COLUMNS} FROM conversation_file_comments WHERE {_SCOPE} AND path = %(path)s "
                "ORDER BY created_at, id LIMIT %(limit)s",
                {"user_id": user_id, "conversation_id": conversation_id, "path": path,
                 "limit": MAX_COMMENTS_PER_DOCUMENT},
            )
            rows = await cur.fetchall()
        return [self._comment(row) for row in rows]

    async def open_threads(self, user_id: str, conversation_id: str) -> list[DocumentOpenThreads]:
        """The open threads of the conversation's documents, for the turn's note.

        Documents with the most recent open thread first, at most
        :data:`TURN_MAX_DOCUMENTS`; of each, the :data:`TURN_MAX_THREADS`
        newest open threads, shown oldest first; of each thread, its first
        :data:`TURN_MAX_REPLIES` replies. Empty when nothing is open.
        """
        params = {"user_id": user_id, "conversation_id": conversation_id, "documents": TURN_MAX_DOCUMENTS,
                  "threads": TURN_MAX_THREADS, "replies": TURN_MAX_REPLIES}
        async with self._pool.connection() as conn:
            cur = await conn.execute(
                "WITH open_threads AS ("
                "SELECT id, path, cipher, anchor, body, author, created_at, "
                "row_number() OVER (PARTITION BY path ORDER BY created_at DESC, id DESC) AS newest, "
                "count(*) OVER (PARTITION BY path) AS open_total, "
                "max(created_at) OVER (PARTITION BY path) AS last_activity "
                f"FROM conversation_file_comments WHERE {_SCOPE} "
                "AND parent_id IS NULL AND status = 'open'), "
                "documents AS (SELECT DISTINCT path, last_activity FROM open_threads "
                "ORDER BY last_activity DESC, path LIMIT %(documents)s) "
                "SELECT t.id, t.path, t.cipher, t.anchor, t.body, t.author, t.open_total "
                "FROM open_threads t JOIN documents d ON d.path = t.path "
                "WHERE t.newest <= %(threads)s "
                "ORDER BY d.last_activity DESC, t.path, t.created_at, t.id",
                params,
            )
            threads = await cur.fetchall()
            if not threads:
                return []
            cur = await conn.execute(
                "SELECT parent_id, cipher, body, author, total FROM ("
                "SELECT parent_id, cipher, body, author, "
                "row_number() OVER (PARTITION BY parent_id ORDER BY created_at, id) AS n, "
                "count(*) OVER (PARTITION BY parent_id) AS total "
                f"FROM conversation_file_comments WHERE {_SCOPE} AND parent_id = ANY(%(ids)s)) r "
                "WHERE n <= %(replies)s ORDER BY parent_id, n",
                {**params, "ids": [row["id"] for row in threads]},
            )
            replies = await cur.fetchall()
        by_thread: dict[str, list[tuple[CommentAuthor, str]]] = {}
        totals: dict[str, int] = {}
        for row in replies:
            key = str(row["parent_id"])
            by_thread.setdefault(key, []).append((row["author"], self._open(row["cipher"], row["body"])))
            totals[key] = int(row["total"])
        documents: list[DocumentOpenThreads] = []
        for row in threads:
            if not documents or documents[-1].path != row["path"]:
                documents.append(DocumentOpenThreads(path=row["path"], threads=[],
                                                     open_total=int(row["open_total"])))
            key = str(row["id"])
            anchor = json.loads(self._open(row["cipher"], row["anchor"]))
            shown = by_thread.get(key, [])
            documents[-1].threads.append(OpenThread(
                quote=str(anchor.get("quote", "")),
                body=self._open(row["cipher"], row["body"]),
                author=row["author"],
                replies=shown,
                more_replies=max(0, totals.get(key, 0) - len(shown)),
            ))
        return documents

    # -- writes --------------------------------------------------------------
    async def add_comment(
        self, user_id: str, conversation_id: str, path: str, *, version: int, body: str,
        anchor: CommentAnchor | None, parent_id: str | None, author: CommentAuthor = "user",
    ) -> DocumentComment:
        """Add a thread (``anchor``, no ``parent_id``) or a reply (``parent_id``, no ``anchor``).

        :class:`DocumentNotFound` when the conversation has no such version of
        the document; :class:`CommentNotFound` when the reply's thread is not a
        comment of this document; :class:`InvalidComment` for a wrong shape;
        :class:`CommentLimitReached` past a limit.
        """
        if (anchor is None) == (parent_id is None):
            raise InvalidComment("A thread needs an anchor; a reply needs the thread it answers, not an anchor.")
        _check_body(body)
        if anchor is not None:
            _check_anchor(anchor)
        scope = {"user_id": user_id, "conversation_id": conversation_id, "path": path}
        async with self._pool.connection() as conn, conn.transaction():
            await self._lock_comments(conn, conversation_id, path)
            cur = await conn.execute(
                f"SELECT 1 FROM conversation_file_versions WHERE {_SCOPE} AND path = %(path)s "
                "AND version = %(version)s",
                {**scope, "version": version},
            )
            if await cur.fetchone() is None:
                raise DocumentNotFound(path)
            if parent_id is not None:
                parent_id = _comment_id(parent_id)
                await self._check_reply(conn, scope, parent_id)
            else:
                cur = await conn.execute(
                    f"SELECT count(*) AS n FROM conversation_file_comments WHERE {_SCOPE} "
                    "AND path = %(path)s AND parent_id IS NULL",
                    scope,
                )
                if int((await cur.fetchone())["n"]) >= MAX_THREADS_PER_DOCUMENT:
                    raise CommentLimitReached(
                        "thread_limit", f"A document holds at most {MAX_THREADS_PER_DOCUMENT} comment threads.")
            cipher, sealed_body = self._seal(body)
            sealed_anchor = None
            if anchor is not None:
                anchor_cipher, sealed_anchor = self._seal(json.dumps(
                    {"quote": anchor.quote, "prefix": anchor.prefix, "suffix": anchor.suffix}, ensure_ascii=False))
                if anchor_cipher != cipher:  # one cipher column for the row's fields
                    raise RuntimeError("The file cipher changed between two fields of one comment.")
            cur = await conn.execute(
                "INSERT INTO conversation_file_comments "
                "(id, user_id, conversation_id, path, version, parent_id, cipher, anchor, body, author, status) "
                "VALUES (%(id)s, %(user_id)s, %(conversation_id)s, %(path)s, %(version)s, %(parent_id)s, "
                "%(cipher)s, %(anchor)s, %(body)s, %(author)s, %(status)s) "
                f"RETURNING {_COLUMNS}",
                {**scope, "id": uuid.uuid4(), "version": version, "parent_id": parent_id, "cipher": cipher,
                 "anchor": sealed_anchor, "body": sealed_body, "author": author,
                 "status": "open" if parent_id is None else None},
            )
            comment = self._comment(await cur.fetchone())
        logger.info("document_comment_added", "Added a comment to a canvas document",
                    reply=parent_id is not None, author=author)
        return comment

    async def update_comment(
        self, user_id: str, conversation_id: str, comment_id: str, *,
        status: CommentStatus | None = None, body: str | None = None,
    ) -> DocumentComment:
        """Resolve or reopen a thread, and/or edit the user's own comment.

        ``status`` only on a thread; resolving by the user sets
        ``resolved_by = 'user'``, reopening clears it and the note. ``body``
        only on a comment the user wrote. :class:`CommentNotFound` when the
        conversation has no such comment; :class:`InvalidComment` otherwise.
        """
        if status is None and body is None:
            raise InvalidComment("Nothing to change.")
        if body is not None:
            _check_body(body)
        scope = {"user_id": user_id, "conversation_id": conversation_id, "id": _comment_id(comment_id)}
        async with self._pool.connection() as conn, conn.transaction():
            cur = await conn.execute(
                f"SELECT {_COLUMNS} FROM conversation_file_comments WHERE {_SCOPE} AND id = %(id)s FOR UPDATE",
                scope,
            )
            row = await cur.fetchone()
            if row is None:
                raise CommentNotFound(comment_id)
            if status is not None and row["parent_id"] is not None:
                raise InvalidComment("Only a thread can be resolved or reopened.")
            if body is not None and row["author"] != "user":
                raise InvalidComment("Only your own comments can be edited.")
            sets: list[str] = ["updated_at = now()"]
            params: dict[str, Any] = dict(scope)
            if body is not None:
                cipher, sealed = self._cipher.encrypt(body.encode("utf-8"))
                if cipher != row["cipher"] and (row["anchor"] is not None or row["resolution_note"] is not None):
                    # The row's other fields were sealed under another cipher
                    # (encryption turned on since): re-seal them with this one.
                    params["anchor"] = (self._seal(self._open(row["cipher"], row["anchor"]))[1]
                                        if row["anchor"] is not None else None)
                    params["note"] = (self._seal(self._open(row["cipher"], row["resolution_note"]))[1]
                                      if row["resolution_note"] is not None else None)
                    sets.extend(["anchor = %(anchor)s", "resolution_note = %(note)s"])
                sets.extend(["cipher = %(cipher)s", "body = %(body)s"])
                params.update(cipher=cipher, body=sealed)
            if status is not None and status != row["status"]:
                sets.append("status = %(status)s")
                params["status"] = status
                # The user resolves (or reopens) it: any earlier note is the agent's, about the old state.
                sets.append("resolved_by = %(resolved_by)s, resolution_note = NULL")
                params["resolved_by"] = "user" if status == "resolved" else None
            cur = await conn.execute(
                f"UPDATE conversation_file_comments SET {', '.join(sets)} "
                f"WHERE {_SCOPE} AND id = %(id)s RETURNING {_COLUMNS}",
                params,
            )
            comment = self._comment(await cur.fetchone())
        logger.info("document_comment_updated", "Updated a comment on a canvas document",
                    status=status, edited=body is not None)
        return comment

    async def delete_comment(self, user_id: str, conversation_id: str, comment_id: str) -> int:
        """Delete the user's own comment; a thread takes its replies with it.

        Returns how many rows went. :class:`CommentNotFound` when the
        conversation has no such comment; :class:`InvalidComment` for a
        comment the user did not write.
        """
        scope = {"user_id": user_id, "conversation_id": conversation_id, "id": _comment_id(comment_id)}
        async with self._pool.connection() as conn, conn.transaction():
            cur = await conn.execute(
                f"SELECT author FROM conversation_file_comments WHERE {_SCOPE} AND id = %(id)s FOR UPDATE",
                scope,
            )
            row = await cur.fetchone()
            if row is None:
                raise CommentNotFound(comment_id)
            if row["author"] != "user":
                raise InvalidComment("Only your own comments can be deleted.")
            cur = await conn.execute(
                f"DELETE FROM conversation_file_comments WHERE {_SCOPE} "
                "AND (id = %(id)s OR parent_id = %(id)s)",
                scope,
            )
            deleted = cur.rowcount or 0
        logger.info("document_comment_deleted", "Deleted a comment from a canvas document", rows=deleted)
        return deleted

    # -- internals -----------------------------------------------------------
    async def _check_reply(self, conn: Any, scope: dict[str, Any], parent_id: str) -> None:
        """A reply's thread: a thread (not a reply) of this document, below its reply cap."""
        cur = await conn.execute(
            f"SELECT parent_id FROM conversation_file_comments WHERE {_SCOPE} AND path = %(path)s "
            "AND id = %(parent)s",
            {**scope, "parent": parent_id},
        )
        parent = await cur.fetchone()
        if parent is None:
            raise CommentNotFound(parent_id)
        if parent["parent_id"] is not None:
            raise InvalidComment("A reply answers a thread, not another reply.")
        cur = await conn.execute(
            f"SELECT count(*) AS n FROM conversation_file_comments WHERE {_SCOPE} AND parent_id = %(parent)s",
            {**scope, "parent": parent_id},
        )
        if int((await cur.fetchone())["n"]) >= MAX_REPLIES_PER_THREAD:
            raise CommentLimitReached(
                "reply_limit", f"A comment thread holds at most {MAX_REPLIES_PER_THREAD} replies.")

    async def _lock_comments(self, conn: Any, conversation_id: str, path: str) -> None:
        """Serialise the comment writes of one document, so the limits hold under concurrency."""
        await conn.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))",
            (f"conversation_file_comments\n{conversation_id}\n{path}",),
        )


__all__ = [
    "MAX_BODY_CHARS",
    "MAX_CONTEXT_CHARS",
    "MAX_QUOTE_CHARS",
    "MAX_REPLIES_PER_THREAD",
    "MAX_RESOLUTION_NOTE_CHARS",
    "MAX_THREADS_PER_DOCUMENT",
    "CommentAnchor",
    "CommentLimitReached",
    "CommentNotFound",
    "DocumentComment",
    "DocumentCommentStore",
    "DocumentOpenThreads",
    "InvalidComment",
    "OpenThread",
]
