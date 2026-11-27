"""A canvas document's versions (plan 44 §4, Phase 4.1).

A canvas document is a markdown file under ``/conversation/output/`` that the
agent presented. Plan 36 keeps one row per path, so an overwrite loses the old
text; this module adds the history: every version of the document is a row in
``conversation_file_versions`` naming a blob in ``conversation_file_blobs``
(the same content-addressed, encrypted bytes as the files — a version that
matches the file costs no extra byte). Each version records its author, the
user or the agent, and the version it was based on.

Versions belong to a branch, like the files (:mod:`.store`): the store is
bound to one, and a fork gives the new branch the versions made up to the fork
point. Each version records the answer message that made it (``message_id``;
for a user save, the answer the user was looking at), which is what that cut
reads.

Two ways a version is written, both serialised per (conversation, branch,
path) by a transaction-scoped advisory lock, so a check-then-insert can never
race:

* **the agent's** — at run end the bridge asks for a :meth:`capture` of the
  documents the run presented, and (Phase 4.3) every document the
  conversation already has; a file whose bytes differ from the latest
  version becomes the next ``agent`` version (same bytes: nothing, so a retry
  is harmless);
* **the user's** — :meth:`save_user_version`, which must name the latest
  version as its base. A stale base is refused with the current text
  (:class:`StaleBase`) instead of last-write-wins; the saved text is also
  written into the file, so the agent's next turn reads the latest version.

A conversation from before this release has documents without versions; the
first read of one records the current file as version 1 (:meth:`latest`).

The DDL lives in :mod:`.store`, beside the blobs whose lifetime the versions
share (its GC, fork copy, reap and purge all count them).
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from pathlib import PurePosixPath
from typing import Any, Literal

from core.logging import get_logger
from harness.conversation_files import paths
from harness.conversation_files.store import ConversationFileStore

logger = get_logger(__name__)

Author = Literal["agent", "user"]

#: The largest document the canvas holds, in UTF-8 bytes (plan 44 contract).
#: A save above it is refused; a bigger file is not captured as a document.
MAX_DOCUMENT_BYTES = 1024 * 1024
DOCUMENT_SUFFIX = ".md"

#: What the provenance column of a file row says after a user save, when the
#: file had no row to keep the agent's slug from.
USER_WRITER = "user"

_SCOPE = (
    "conversation_id = %(conversation_id)s AND branch_thread_id = %(branch)s AND user_id = %(user_id)s"
)
_VERSION_COLUMNS = "v.path, v.version, v.author, v.base_version, v.size_bytes, v.sha256, v.created_at"


class InvalidDocumentPath(ValueError):
    """A path that cannot be a canvas document (not a ``.md`` under output/)."""


class DocumentNotFound(LookupError):
    """No such document, or no such version of it."""


class DocumentTooLarge(ValueError):
    """Content over :data:`MAX_DOCUMENT_BYTES`."""


class DocumentPathTaken(ValueError):
    """The path is a directory, or under a file, so no document can be saved there."""


class StaleBase(Exception):
    """A save based on a version that is no longer the latest.

    Carries the latest version and its text, so the caller can show both
    instead of overwriting the newer one.
    """

    def __init__(self, current_version: int, current_content: str) -> None:
        super().__init__(f"The latest version is {current_version}.")
        self.current_version = current_version
        self.current_content = current_content


@dataclass(frozen=True)
class DocumentVersion:
    """One version's metadata; ``content`` only when it was asked for."""

    path: str
    version: int
    author: Author
    base_version: int | None
    size_bytes: int
    sha256: str
    created_at: datetime
    content: str | None = None

    @property
    def name(self) -> str:
        return PurePosixPath(self.path).name


@dataclass(frozen=True)
class CaptureResult:
    """What a capture did for one path: the latest version, and whether it is new."""

    path: str
    version: int
    created: bool


def document_path(path: str) -> str:
    """The canonical form of a canvas document's path, or :class:`InvalidDocumentPath`.

    Absolute, normalised (:func:`paths.normalise`), under ``/conversation/output/``
    and ending ``.md`` — the same rule as the table's CHECK constraint.
    """
    try:
        canonical = paths.normalise(path)
    except paths.InvalidPath as exc:
        raise InvalidDocumentPath(str(exc)) from exc
    stem = canonical[len(paths.OUTPUT_PREFIX):]
    if not canonical.startswith(paths.OUTPUT_PREFIX) or not stem.endswith(DOCUMENT_SUFFIX) \
            or stem == DOCUMENT_SUFFIX or stem.endswith(f"/{DOCUMENT_SUFFIX}"):
        raise InvalidDocumentPath("A canvas document is a .md file under /conversation/output/.")
    return canonical


def _version(row: dict[str, Any], content: str | None = None) -> DocumentVersion:
    return DocumentVersion(
        path=row["path"],
        version=int(row["version"]),
        author=row["author"],
        base_version=row["base_version"],
        size_bytes=int(row["size_bytes"]),
        sha256=row["sha256"],
        created_at=row["created_at"],
        content=content,
    )


def _text(data: bytes) -> str:
    """A document's bytes as text. The agent may have written invalid UTF-8;
    the canvas shows the replacement character rather than failing to open."""
    return data.decode("utf-8", errors="replace")


class DocumentVersionStore(ConversationFileStore):
    """The canvas documents of one user's conversations, over the file store's tables.

    A subclass on purpose: a version is written with the very blob primitives
    a file is (:meth:`_save_blob`, :meth:`_collect_garbage`, the cipher), and
    a user save writes the file row in the same transaction as the version.
    Every statement filters on ``conversation_id``, the store's branch and ``user_id``.
    """

    # -- reads ---------------------------------------------------------------
    async def list_documents(self, user_id: str, conversation_id: str, *, limit: int) -> list[DocumentVersion]:
        """The latest version of each document, newest first, at most ``limit``."""
        async with self._connect(user_id, conversation_id) as conn:
            cur = await conn.execute(
                f"SELECT * FROM (SELECT DISTINCT ON (v.path) {_VERSION_COLUMNS} "
                "FROM conversation_file_versions v "
                "WHERE v.conversation_id = %(conversation_id)s AND v.branch_thread_id = %(branch)s "
                "AND v.user_id = %(user_id)s "
                "ORDER BY v.path, v.version DESC) latest "
                "ORDER BY created_at DESC, path LIMIT %(limit)s",
                {"user_id": user_id, "conversation_id": conversation_id, "limit": limit},
            )
            return [_version(row) for row in await cur.fetchall()]

    async def document_paths(self, user_id: str, conversation_id: str, *, limit: int) -> list[str]:
        """Every path of the conversation that has versions, in path order, at most ``limit``.

        What a run-end capture checks besides the presented paths (plan 44
        4.3): an Ask agent edit changes the file with ``edit_file`` and need
        not present it again, yet must become the agent's next version.
        """
        async with self._connect(user_id, conversation_id) as conn:
            cur = await conn.execute(
                f"SELECT DISTINCT path FROM conversation_file_versions WHERE {_SCOPE} "
                "ORDER BY path LIMIT %(limit)s",
                {"user_id": user_id, "conversation_id": conversation_id, "limit": limit},
            )
            return [row["path"] for row in await cur.fetchall()]

    async def list_versions(
        self, user_id: str, conversation_id: str, path: str, *, limit: int
    ) -> list[DocumentVersion]:
        """A document's versions without their text, newest first. Empty when it has none."""
        async with self._connect(user_id, conversation_id) as conn:
            cur = await conn.execute(
                f"SELECT {_VERSION_COLUMNS} FROM conversation_file_versions v "
                "WHERE v.conversation_id = %(conversation_id)s AND v.branch_thread_id = %(branch)s "
                "AND v.user_id = %(user_id)s "
                "AND v.path = %(path)s ORDER BY v.version DESC LIMIT %(limit)s",
                {"user_id": user_id, "conversation_id": conversation_id, "path": path, "limit": limit},
            )
            return [_version(row) for row in await cur.fetchall()]

    async def get_version(self, user_id: str, conversation_id: str, path: str, version: int) -> DocumentVersion:
        """One version with its text, or :class:`DocumentNotFound`."""
        async with self._connect(user_id, conversation_id) as conn:
            found = await self._read_version(conn, user_id, conversation_id, path, version)
        if found is None:
            raise DocumentNotFound(path)
        return found

    async def latest(self, user_id: str, conversation_id: str, path: str) -> DocumentVersion:
        """The latest version with its text.

        A document with no versions yet (written before this release, or
        presented by a run whose capture failed) gets its current file
        recorded as version 1 by the agent first. :class:`DocumentNotFound`
        when there is neither a version nor a file.
        """
        async with self._connect(user_id, conversation_id) as conn:
            found = await self._read_version(conn, user_id, conversation_id, path, None)
            if found is not None:
                return found
            async with conn.transaction():
                await self._lock(conn, conversation_id, path)
                # Re-read under the lock: a concurrent first read may have
                # recorded it while this one waited.
                found = await self._read_version(conn, user_id, conversation_id, path, None)
                if found is None:
                    if await self._record_file(conn, user_id, conversation_id, path,
                                               author="agent", run_id=None) is None:
                        raise DocumentNotFound(path)
                    logger.info("document_version_materialised",
                                "Recorded an existing document as its first version")
                    found = await self._read_version(conn, user_id, conversation_id, path, None)
        if found is None:
            raise DocumentNotFound(path)
        return found

    # -- writes --------------------------------------------------------------
    async def capture(
        self, user_id: str, conversation_id: str, document_paths: list[str], *, run_id: str | None
    ) -> list[CaptureResult]:
        """Record each document's current file as an ``agent`` version if it changed.

        Idempotent: a file whose bytes equal the latest version's adds nothing
        (``created=False``). A path with no file, or a file over the size cap,
        is skipped and absent from the result. One transaction per path, so one
        bad path never undoes the others.
        """
        results: list[CaptureResult] = []
        async with self._connect(user_id, conversation_id) as conn:
            for path in document_paths:
                async with conn.transaction():
                    await self._lock(conn, conversation_id, path)
                    result = await self._record_file(conn, user_id, conversation_id, path,
                                                     author="agent", run_id=run_id)
                if result is not None:
                    results.append(result)
        logger.info("documents_captured", "Recorded the presented documents' versions",
                    requested=len(document_paths), recorded=len(results),
                    created=sum(1 for r in results if r.created))
        return results

    async def save_user_version(
        self, user_id: str, conversation_id: str, path: str, *, base_version: int, content: str
    ) -> DocumentVersion:
        """Save the user's text as the next version, if ``base_version`` is the latest.

        Under the per-document lock: a stale base raises :class:`StaleBase`
        with the latest text, so of two saves from the same base exactly one
        wins. The text also replaces the file, so the agent works on the latest
        version. A document with no versions gets its file recorded as v1
        first (the user was shown that one). :class:`DocumentNotFound` when
        there is neither; :class:`DocumentTooLarge` over the cap.
        """
        data = content.encode("utf-8")
        if len(data) > MAX_DOCUMENT_BYTES:
            raise DocumentTooLarge(path)
        async with self._connect(user_id, conversation_id) as conn, conn.transaction():
            await self._lock(conn, conversation_id, path)
            current = await self._read_version(conn, user_id, conversation_id, path, None)
            if current is None:
                if await self._record_file(conn, user_id, conversation_id, path,
                                           author="agent", run_id=None) is None:
                    raise DocumentNotFound(path)
                current = await self._read_version(conn, user_id, conversation_id, path, None)
                if current is None:
                    raise DocumentNotFound(path)
            if base_version != current.version:
                raise StaleBase(current.version, current.content or "")
            if await self._conflict(conn, user_id, conversation_id, path, allow_existing=True) is not None:
                raise DocumentPathTaken(path)
            sha256 = await self._save_blob(conn, user_id, data)
            cur = await conn.execute(
                "INSERT INTO conversation_file_versions "
                "(user_id, conversation_id, branch_thread_id, path, version, sha256, size_bytes, author, "
                "base_version, message_id) "
                "VALUES (%(user_id)s, %(conversation_id)s, %(branch)s, %(path)s, %(version)s, %(sha256)s, "
                "%(size)s, 'user', %(base)s, %(message_id)s) "
                "RETURNING path, version, author, base_version, size_bytes, sha256, created_at",
                {"user_id": user_id, "conversation_id": conversation_id, "path": path,
                 "version": current.version + 1, "sha256": sha256, "size": len(data), "base": base_version},
            )
            saved = _version(await cur.fetchone(), content)
            await self._write_file(conn, user_id, conversation_id, path, sha256, len(data))
        logger.info("document_version_saved", "Saved the user's version of a document",
                    version=saved.version, size_bytes=saved.size_bytes)
        return saved

    # -- internals -----------------------------------------------------------
    async def _lock(self, conn: Any, conversation_id: str, path: str) -> None:
        """Serialise every version write of one document until this transaction ends.

        An advisory lock rather than ``FOR UPDATE`` on the latest row, because
        a document's first version has no row to lock yet. A hash collision
        between two documents only makes them wait for each other.
        """
        await conn.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))",
            (f"conversation_file_versions\n{conversation_id}\n{self._branch}\n{path}",),
        )

    async def _read_version(
        self, conn: Any, user_id: str, conversation_id: str, path: str, version: int | None
    ) -> DocumentVersion | None:
        """One version (the latest when ``version`` is None) with its text."""
        where = "AND v.version = %(version)s " if version is not None else ""
        cur = await conn.execute(
            f"SELECT {_VERSION_COLUMNS}, b.cipher, b.data FROM conversation_file_versions v "
            "JOIN conversation_file_blobs b ON b.user_id = v.user_id AND b.sha256 = v.sha256 "
            "WHERE v.conversation_id = %(conversation_id)s AND v.branch_thread_id = %(branch)s "
            "AND v.user_id = %(user_id)s "
            f"AND v.path = %(path)s {where}ORDER BY v.version DESC LIMIT 1",
            {"user_id": user_id, "conversation_id": conversation_id, "path": path, "version": version},
        )
        row = await cur.fetchone()
        if row is None:
            return None
        return _version(row, _text(self._cipher.decrypt(row["cipher"], bytes(row["data"]))))

    async def _record_file(
        self, conn: Any, user_id: str, conversation_id: str, path: str, *,
        author: Author, run_id: str | None,
    ) -> CaptureResult | None:
        """Add the file at ``path`` as the next version unless the latest already has its bytes.

        Runs inside the caller's transaction, under its lock. The file row is
        read ``FOR SHARE`` so the blob it names cannot be replaced (and
        collected) before the version row names it too. None when there is no
        file, or it is over the size cap.
        """
        cur = await conn.execute(
            f"SELECT sha256, size_bytes FROM conversation_files WHERE {_SCOPE} AND path = %(path)s FOR SHARE",
            {"user_id": user_id, "conversation_id": conversation_id, "path": path},
        )
        file_row = await cur.fetchone()
        if file_row is None or int(file_row["size_bytes"]) > MAX_DOCUMENT_BYTES:
            return None
        cur = await conn.execute(
            f"SELECT version, sha256 FROM conversation_file_versions WHERE {_SCOPE} AND path = %(path)s "
            "ORDER BY version DESC LIMIT 1",
            {"user_id": user_id, "conversation_id": conversation_id, "path": path},
        )
        latest = await cur.fetchone()
        if latest is not None and latest["sha256"] == file_row["sha256"]:
            return CaptureResult(path=path, version=int(latest["version"]), created=False)
        version = int(latest["version"]) + 1 if latest is not None else 1
        await conn.execute(
            "INSERT INTO conversation_file_versions "
            "(user_id, conversation_id, branch_thread_id, path, version, sha256, size_bytes, author, "
            "base_version, source_run_id, message_id) "
            "VALUES (%(user_id)s, %(conversation_id)s, %(branch)s, %(path)s, %(version)s, %(sha256)s, %(size)s, "
            "%(author)s, %(base)s, %(run_id)s, %(message_id)s)",
            {"user_id": user_id, "conversation_id": conversation_id, "path": path, "version": version,
             "sha256": file_row["sha256"], "size": int(file_row["size_bytes"]), "author": author,
             "base": int(latest["version"]) if latest is not None else None, "run_id": run_id},
        )
        return CaptureResult(path=path, version=version, created=True)

    async def _write_file(
        self, conn: Any, user_id: str, conversation_id: str, path: str, sha256: str, size: int
    ) -> None:
        """Point the document's file row at the saved bytes, keeping its provenance.

        Logged like any write, so a fork cuts the user's save where it was
        made. The previous blob is collected if nothing names it any more —
        which, with a version naming every blob a document ever had, is rare.
        """
        cur = await conn.execute(
            f"SELECT sha256 FROM conversation_files WHERE {_SCOPE} AND path = %(path)s FOR UPDATE",
            {"user_id": user_id, "conversation_id": conversation_id, "path": path},
        )
        previous = await cur.fetchone()
        await conn.execute(
            "INSERT INTO conversation_files "
            "(conversation_id, branch_thread_id, path, user_id, sha256, size_bytes, agent_slug, source_run_id) "
            "VALUES (%(conversation_id)s, %(branch)s, %(path)s, %(user_id)s, %(sha256)s, %(size)s, %(writer)s, "
            "NULL) "
            "ON CONFLICT (conversation_id, branch_thread_id, path) DO UPDATE SET sha256 = EXCLUDED.sha256, "
            "size_bytes = EXCLUDED.size_bytes, source_run_id = NULL, updated_at = now()",
            {"user_id": user_id, "conversation_id": conversation_id, "path": path,
             "sha256": sha256, "size": size, "writer": USER_WRITER},
        )
        if previous is None or previous["sha256"] != sha256:
            await self._log_write(conn, user_id, conversation_id, path, sha256, size, USER_WRITER)
        if previous is not None and previous["sha256"] != sha256:
            await self._collect_garbage(conn, user_id, [previous["sha256"]])
