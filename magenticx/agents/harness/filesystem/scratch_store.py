"""The branch scratch store: the workspace's default route as rows (plan 41 §3.7).

Everything a deep agent writes outside a mounted route (``/notes.md``,
``/drafts/plan.md``) used to live in the ``files`` key of one thread's graph
state. An async sub-agent runs on its own thread, so it could not see the
orchestrator's files, nor they its. This table replaces that state key with
rows keyed by ``(conversation_id, branch_thread_id, path)``: the orchestrator
and every task in its tree carry the same branch thread id, so they read and
write the same files, live.

* **Per branch, like before.** Edit and retry create a sibling branch with its
  own thread; :meth:`BranchScratchStore.copy_branch` gives it the source
  branch's files **as they were at the fork point** (copy-on-fork, called from
  ``harness.checkpointer.fork``), after which the two diverge.
* **A write log for the cut.** ``branch_scratch_writes`` keeps, per path, the
  latest content each answer wrote (``message_id``; ``''`` for a write no
  answer made), ordered by ``seq``. A fork takes each path's latest write by an
  answer on the path to the fork point, so what the source wrote after it
  stays there. One row per (branch, path, answer), not per write: only an
  answer's last write to a path can ever be cut to, so an agent editing one
  file a hundred times in a turn keeps one row.
* **Versions are content hashes.** ``sha256`` is the hash of the plaintext and
  doubles as the row's version: ``write_file`` is last-write-wins
  (:meth:`put`), ``edit_file`` is a compare-and-set on the hash it read
  (:meth:`compare_and_set`), so two agents editing one file never silently
  undo each other.
* **Encrypted at rest** with the checkpointer's key and cipher
  (:mod:`harness.conversation_files.cipher`) — the same data the ``files``
  state key held, under the same protection the checkpoints gave it.
* **Bytes inline, not content-addressed.** Scratch files are small working
  notes, so each row carries its own ciphertext. Sharing
  ``conversation_file_blobs`` would tie these rows into that table's garbage
  collection, which only knows ``conversation_files``.
* **Lifetime = the conversation.** :meth:`delete_conversation` (conversation
  reap) and :meth:`purge_user` (account deletion) remove the rows.

``branch_scratch_imports`` records, per branch, that the one-shot import of the
legacy ``files`` state key has run (:mod:`harness.filesystem.scratch_migration`).
It and the import methods here go away with that module in the next release.
So does :data:`_BACKFILL`: the one-shot that gives every file written before
the log a no-answer row, so it still comes along on a fork, as it did before.

The service is this table's only reader and writer, so — like the conversation
files, memory and skills — it owns the DDL and creates it idempotently.
"""
from __future__ import annotations

import asyncio
import hashlib
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime
from typing import Any, ClassVar, Literal

from core.logging import get_logger
from core.settings import settings
from harness.conversation_files import paths
from harness.conversation_files.cipher import FileCipher, get_file_cipher
from harness.memory import get_memory_pool

logger = get_logger(__name__)

#: How a file's bytes are meant to be read: text, or binary that deepagents
#: hands around base64-encoded (``FileData.encoding``).
Encoding = Literal["utf-8", "base64"]
ENCODINGS: tuple[str, ...] = ("utf-8", "base64")

_DDL = (
    """
    CREATE TABLE IF NOT EXISTS branch_scratch_files (
        conversation_id   text NOT NULL,
        branch_thread_id  text NOT NULL,
        path              text COLLATE "C" NOT NULL,
        user_id           text NOT NULL,
        sha256            text NOT NULL,
        size_bytes        bigint NOT NULL,
        encoding          text NOT NULL,
        cipher            text NOT NULL,
        data              bytea NOT NULL,
        agent_slug        text NOT NULL,
        created_at        timestamptz NOT NULL DEFAULT now(),
        updated_at        timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (conversation_id, branch_thread_id, path),
        CONSTRAINT branch_scratch_files_path_ck CHECK (path ~ '^/.+'),
        CONSTRAINT branch_scratch_files_encoding_ck CHECK (encoding IN ('utf-8', 'base64'))
    )
    """,
    # Encrypted bytes do not compress; EXTERNAL skips the futile attempt.
    "ALTER TABLE branch_scratch_files ALTER COLUMN data SET STORAGE EXTERNAL",
    # The account purge deletes by user; copy-on-fork reads by source thread.
    "CREATE INDEX IF NOT EXISTS branch_scratch_files_user_idx ON branch_scratch_files (user_id)",
    "CREATE INDEX IF NOT EXISTS branch_scratch_files_thread_idx ON branch_scratch_files (branch_thread_id)",
    # One-shot (plan 41 §3.7): which branches already had their legacy `files`
    # state imported. Dropped with harness/filesystem/scratch_migration.py.
    """
    CREATE TABLE IF NOT EXISTS branch_scratch_imports (
        conversation_id   text NOT NULL,
        branch_thread_id  text NOT NULL,
        user_id           text NOT NULL,
        files             integer NOT NULL,
        imported_at       timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (conversation_id, branch_thread_id)
    )
    """,
    "CREATE INDEX IF NOT EXISTS branch_scratch_imports_user_idx ON branch_scratch_imports (user_id)",
    # What a fork cuts on: per (branch, path, answer), that answer's latest
    # write, bytes included (the files table keeps only the newest). seq orders
    # the writes; message_id '' is a write no answer made.
    """
    CREATE TABLE IF NOT EXISTS branch_scratch_writes (
        conversation_id   text NOT NULL,
        branch_thread_id  text NOT NULL,
        path              text COLLATE "C" NOT NULL,
        message_id        text NOT NULL DEFAULT '',
        seq               bigserial NOT NULL,
        user_id           text NOT NULL,
        sha256            text NOT NULL,
        size_bytes        bigint NOT NULL,
        encoding          text NOT NULL,
        cipher            text NOT NULL,
        data              bytea NOT NULL,
        agent_slug        text NOT NULL,
        created_at        timestamptz NOT NULL DEFAULT now(),
        updated_at        timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (conversation_id, branch_thread_id, path, message_id)
    )
    """,
    "ALTER TABLE branch_scratch_writes ALTER COLUMN data SET STORAGE EXTERNAL",
    "CREATE INDEX IF NOT EXISTS branch_scratch_writes_user_idx ON branch_scratch_writes (user_id)",
    "CREATE INDEX IF NOT EXISTS branch_scratch_writes_thread_idx ON branch_scratch_writes (branch_thread_id)",
)

#: One-shot (removed with :mod:`harness.filesystem.scratch_migration`): every
#: file with no log row yet — written before the log — gets a no-answer row, so
#: a fork still takes it, as before. A file written since always has a row, so
#: a rerun adds nothing.
_BACKFILL = (
    "INSERT INTO branch_scratch_writes (conversation_id, branch_thread_id, path, message_id, user_id, sha256, "
    "size_bytes, encoding, cipher, data, agent_slug, created_at, updated_at) "
    "SELECT f.conversation_id, f.branch_thread_id, f.path, '', f.user_id, f.sha256, f.size_bytes, f.encoding, "
    "f.cipher, f.data, f.agent_slug, f.created_at, f.updated_at FROM branch_scratch_files f "
    "WHERE NOT EXISTS (SELECT 1 FROM branch_scratch_writes w WHERE w.conversation_id = f.conversation_id "
    "AND w.branch_thread_id = f.branch_thread_id AND w.path = f.path) "
    "ON CONFLICT DO NOTHING"
)

#: Log one write: the answer's row for the path takes the new content and the
#: next ``seq``. Runs in the same transaction as the write it logs.
_LOG_WRITE = (
    "INSERT INTO branch_scratch_writes (conversation_id, branch_thread_id, path, message_id, user_id, sha256, "
    "size_bytes, encoding, cipher, data, agent_slug) "
    "VALUES (%(conversation_id)s, %(branch_thread_id)s, %(path)s, %(message_id)s, %(user_id)s, %(sha256)s, "
    "%(size)s, %(encoding)s, %(cipher)s, %(data)s, %(agent_slug)s) "
    "ON CONFLICT (conversation_id, branch_thread_id, path, message_id) DO UPDATE SET "
    "seq = nextval(pg_get_serial_sequence('branch_scratch_writes', 'seq')), sha256 = EXCLUDED.sha256, "
    "size_bytes = EXCLUDED.size_bytes, encoding = EXCLUDED.encoding, cipher = EXCLUDED.cipher, "
    "data = EXCLUDED.data, agent_slug = EXCLUDED.agent_slug, updated_at = now() "
    "WHERE branch_scratch_writes.user_id = EXCLUDED.user_id"
)

_COMMENTS = (
    "COMMENT ON TABLE branch_scratch_files IS "
    "'The workspace default route per conversation branch (plan 41): shared live by the orchestrator "
    "and every async task of the branch.'",
    "COMMENT ON COLUMN branch_scratch_files.sha256 IS "
    "'sha256 of the plaintext; the row version edit_file compares-and-sets on.'",
    "COMMENT ON COLUMN branch_scratch_files.cipher IS "
    "'none, or the LangGraph cipher name (aes) that encrypted data with LANGGRAPH_AES_KEY.'",
    "COMMENT ON TABLE branch_scratch_imports IS "
    "'One-shot marker: the legacy checkpoint files of this branch were imported (plan 41). "
    "Dropped in the release after.'",
    "COMMENT ON TABLE branch_scratch_writes IS "
    "'Per branch, path and answer, the latest scratch write that answer made; a fork cuts on it.'",
    "COMMENT ON COLUMN branch_scratch_writes.message_id IS "
    "'The answer message that wrote; empty for a write no answer made (always kept by a fork).'",
)

_ENTRY_COLUMNS = "path, size_bytes, sha256, encoding, created_at, updated_at"
_SCOPE = (
    "conversation_id = %(conversation_id)s AND branch_thread_id = %(branch_thread_id)s "
    "AND user_id = %(user_id)s"
)
#: Serialises the DDL across replicas: concurrent CREATE TABLE IF NOT EXISTS
#: can still collide on the catalog.
_SETUP_LOCK_KEY = "branch_scratch_setup"


@dataclass(frozen=True)
class ScratchScope:
    """One branch's scratch: whose it is, which conversation, which branch."""

    user_id: str
    conversation_id: str
    branch_thread_id: str

    def params(self, **extra: Any) -> dict[str, Any]:
        """The scope as query parameters, plus ``extra``."""
        return {
            "user_id": self.user_id,
            "conversation_id": self.conversation_id,
            "branch_thread_id": self.branch_thread_id,
            **extra,
        }


@dataclass(frozen=True)
class ScratchEntry:
    """A scratch file without its bytes — what listing and globbing work from."""

    path: str
    size: int
    sha256: str
    encoding: str
    created_at: datetime
    updated_at: datetime


@dataclass(frozen=True)
class ScratchFile:
    """A scratch file with its plaintext bytes."""

    entry: ScratchEntry
    data: bytes


class ScratchFileTooLarge(ValueError):
    """A write over the per-file cap — refused before anything is stored."""


def _entry(row: Mapping[str, Any]) -> ScratchEntry:
    return ScratchEntry(
        path=row["path"],
        size=int(row["size_bytes"]),
        sha256=row["sha256"],
        encoding=row["encoding"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


def content_hash(data: bytes) -> str:
    """The version of a file's content, as the table stores it."""
    return hashlib.sha256(data).hexdigest()


class BranchScratchStore:
    """Reads and writes one user's branch scratch files.

    Every statement on files filters on ``user_id``, ``conversation_id`` and
    ``branch_thread_id`` together, so a wrong id from a caller can never reach
    another user's or another conversation's rows. Paths are expected already
    normalised (:func:`harness.conversation_files.paths.normalise`).

    ``pool`` defaults to the service's ``agent_runtime`` pool, resolved at the
    first query rather than here, so minting a backend does no I/O.
    """

    #: Pools whose tables this process has already ensured (by ``id``).
    _ready: ClassVar[set[int]] = set()
    #: One lock per event loop: an asyncio lock is bound to the loop it first
    #: waits on, and tests run several loops in one process.
    _ready_locks: ClassVar[dict[int, asyncio.Lock]] = {}

    def __init__(self, pool: Any | None = None, cipher: FileCipher | None = None) -> None:
        self._explicit_pool = pool
        self._cipher = cipher

    @property
    def pool(self) -> Any:
        return self._explicit_pool if self._explicit_pool is not None else get_memory_pool()

    @property
    def cipher(self) -> FileCipher:
        if self._cipher is None:
            self._cipher = get_file_cipher()
        return self._cipher

    # -- schema --------------------------------------------------------------
    async def setup(self) -> None:
        """Create the tables if absent — ``agent_runtime`` has no alembic chain."""
        async with self.pool.connection() as conn, conn.transaction():
            await conn.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", (_SETUP_LOCK_KEY,))
            for statement in (*_DDL, *_COMMENTS, _BACKFILL):
                await conn.execute(statement)

    async def ensure_setup(self) -> None:
        """:meth:`setup` once per pool per process, before the first query.

        The service bootstrap does not know this table yet (it lives outside
        this module's package), so the store makes sure of it itself; a second
        call is a set lookup.
        """
        pool = self.pool
        if id(pool) in BranchScratchStore._ready:
            return
        lock = BranchScratchStore._ready_locks.setdefault(id(asyncio.get_running_loop()), asyncio.Lock())
        async with lock:
            if id(pool) in BranchScratchStore._ready:
                return
            await self.setup()
            BranchScratchStore._ready.add(id(pool))

    # -- reads ---------------------------------------------------------------
    async def list_files(self, scope: ScratchScope, directory: str = "/") -> list[ScratchEntry]:
        """Every file at ``directory`` or below it, in path order, without bytes."""
        lower, upper = paths.children_range(directory)
        async with self.pool.connection() as conn:
            cur = await conn.execute(
                f"SELECT {_ENTRY_COLUMNS} FROM branch_scratch_files WHERE {_SCOPE} "
                "AND (path = %(path)s OR (path >= %(lower)s AND path < %(upper)s)) ORDER BY path",
                scope.params(path=directory, lower=lower, upper=upper),
            )
            return [_entry(row) for row in await cur.fetchall()]

    async def get(self, scope: ScratchScope, path: str) -> ScratchFile | None:
        """One file with its bytes, or None."""
        return (await self.read_many(scope, [path])).get(path)

    async def read_many(self, scope: ScratchScope, file_paths: list[str]) -> dict[str, ScratchFile]:
        """Each named file that exists, with its plaintext, keyed by path."""
        if not file_paths:
            return {}
        async with self.pool.connection() as conn:
            cur = await conn.execute(
                f"SELECT {_ENTRY_COLUMNS}, cipher, data FROM branch_scratch_files WHERE {_SCOPE} "
                "AND path = ANY(%(paths)s)",
                scope.params(paths=list(file_paths)),
            )
            rows = await cur.fetchall()
        return {
            row["path"]: ScratchFile(_entry(row), self.cipher.decrypt(row["cipher"], bytes(row["data"])))
            for row in rows
        }

    # -- writes --------------------------------------------------------------
    def _checked(self, data: bytes, encoding: str) -> None:
        if encoding not in ENCODINGS:
            raise ValueError(f"Unknown scratch encoding: {encoding!r}")
        cap = settings.conversation_files.max_file_bytes
        if len(data) > cap:
            raise ScratchFileTooLarge(f"{len(data)} bytes is over the {cap} byte limit for one file.")

    async def put(
        self, scope: ScratchScope, path: str, data: bytes, *, encoding: Encoding, agent_slug: str,
        message_id: str | None = None,
    ) -> str | None:
        """Write a file, replacing whatever is there (last write wins).

        ``message_id`` is the answer the write belongs to, logged for the fork
        cut. Returns the new version, or None when the row at this key belongs
        to another user — which a correct caller never meets, and which is
        refused rather than overwritten.
        """
        self._checked(data, encoding)
        cipher_name, stored = self.cipher.encrypt(data)
        sha256 = content_hash(data)
        async with self.pool.connection() as conn, conn.transaction():
            cur = await conn.execute(
                "INSERT INTO branch_scratch_files (conversation_id, branch_thread_id, path, user_id, "
                "sha256, size_bytes, encoding, cipher, data, agent_slug) "
                "VALUES (%(conversation_id)s, %(branch_thread_id)s, %(path)s, %(user_id)s, %(sha256)s, "
                "%(size)s, %(encoding)s, %(cipher)s, %(data)s, %(agent_slug)s) "
                "ON CONFLICT (conversation_id, branch_thread_id, path) DO UPDATE SET "
                "sha256 = EXCLUDED.sha256, size_bytes = EXCLUDED.size_bytes, encoding = EXCLUDED.encoding, "
                "cipher = EXCLUDED.cipher, data = EXCLUDED.data, agent_slug = EXCLUDED.agent_slug, "
                "updated_at = now() WHERE branch_scratch_files.user_id = EXCLUDED.user_id "
                "RETURNING sha256",
                scope.params(path=path, sha256=sha256, size=len(data), encoding=encoding,
                             cipher=cipher_name, data=stored, agent_slug=agent_slug),
            )
            row = await cur.fetchone()
            if row is not None:
                await self._log_write(conn, scope, path, sha256, len(data), encoding, cipher_name, stored,
                                      agent_slug, message_id)
        return row["sha256"] if row else None

    async def compare_and_set(
        self, scope: ScratchScope, path: str, expected_sha256: str, data: bytes, *,
        encoding: Encoding, agent_slug: str, message_id: str | None = None,
    ) -> str | None:
        """Replace a file only if it is still at ``expected_sha256``.

        Returns the new version, or None when the file changed (or vanished)
        since that version was read — the caller re-reads and retries. This is
        the optimistic half of ``edit_file``: no lock is held while the agent
        decides what to change.
        """
        self._checked(data, encoding)
        cipher_name, stored = self.cipher.encrypt(data)
        sha256 = content_hash(data)
        async with self.pool.connection() as conn, conn.transaction():
            cur = await conn.execute(
                "UPDATE branch_scratch_files SET sha256 = %(sha256)s, size_bytes = %(size)s, "
                "encoding = %(encoding)s, cipher = %(cipher)s, data = %(data)s, "
                "agent_slug = %(agent_slug)s, updated_at = now() "
                f"WHERE {_SCOPE} AND path = %(path)s AND sha256 = %(expected)s RETURNING sha256",
                scope.params(path=path, expected=expected_sha256, sha256=sha256, size=len(data),
                             encoding=encoding, cipher=cipher_name, data=stored, agent_slug=agent_slug),
            )
            row = await cur.fetchone()
            if row is not None:
                await self._log_write(conn, scope, path, sha256, len(data), encoding, cipher_name, stored,
                                      agent_slug, message_id)
        return row["sha256"] if row else None

    async def _log_write(
        self, conn: Any, scope: ScratchScope, path: str, sha256: str, size: int, encoding: str,
        cipher_name: str, stored: bytes, agent_slug: str, message_id: str | None,
    ) -> None:
        """Record a write in the branch's log, in the caller's transaction."""
        await conn.execute(_LOG_WRITE, scope.params(
            path=path, message_id=message_id or "", sha256=sha256, size=size, encoding=encoding,
            cipher=cipher_name, data=stored, agent_slug=agent_slug,
        ))

    # -- branches and conversations -------------------------------------------
    async def copy_branch(
        self, source_thread_id: str, target_thread_id: str, messages: list[str] | None = None
    ) -> int:
        """Copy-on-fork: give ``target_thread_id`` the scratch files of ``source_thread_id``.

        ``messages`` are the answers on the path from the root to the fork
        point. Each path comes as the latest write one of them made (or a write
        no answer made), so what the source wrote after the fork point stays
        there. ``None`` copies the source's files as they are now. The target's
        log gets the copied writes, with their answers, so a fork of the fork
        cuts correctly too.

        The rows keep their conversation and user — a branch thread belongs to
        exactly one conversation, and thread ids are random UUIDs minted by the
        bridge — and the ciphertext is copied as stored, never decrypted. Paths
        the target already has are kept, so a retried fork changes nothing.
        """
        if not source_thread_id or not target_thread_id or source_thread_id == target_thread_id:
            return 0
        if messages is None:
            # The source as it is now; each path's answer is that of its latest log row.
            picked = (
                "SELECT DISTINCT ON (f.conversation_id, f.path) f.conversation_id, f.path, f.user_id, f.sha256, "
                "f.size_bytes, f.encoding, f.cipher, f.data, f.agent_slug, f.created_at, f.updated_at, "
                "coalesce(w.message_id, '') AS message_id FROM branch_scratch_files f "
                "LEFT JOIN branch_scratch_writes w ON w.conversation_id = f.conversation_id "
                "AND w.branch_thread_id = f.branch_thread_id AND w.path = f.path "
                "WHERE f.branch_thread_id = %(source)s ORDER BY f.conversation_id, f.path, w.seq DESC NULLS LAST"
            )
        else:
            # Each path's latest write by an answer on the path to the fork point.
            picked = (
                "SELECT DISTINCT ON (conversation_id, path) conversation_id, path, user_id, sha256, size_bytes, "
                "encoding, cipher, data, agent_slug, created_at, updated_at, message_id "
                "FROM branch_scratch_writes WHERE branch_thread_id = %(source)s "
                "AND (message_id = '' OR message_id = ANY(%(messages)s)) "
                "ORDER BY conversation_id, path, seq DESC"
            )
        columns = ("sha256", "size_bytes", "encoding", "cipher", "data", "agent_slug", "created_at", "updated_at")
        plain = ", ".join(columns)
        prefixed = ", ".join(f"p.{column}" for column in columns)
        async with self.pool.connection() as conn:
            cur = await conn.execute(
                f"WITH picked AS ({picked}), "
                "copied AS ("
                f"INSERT INTO branch_scratch_files (conversation_id, branch_thread_id, path, user_id, {plain}) "
                f"SELECT conversation_id, %(target)s, path, user_id, {plain} FROM picked "
                "ON CONFLICT (conversation_id, branch_thread_id, path) DO NOTHING "
                "RETURNING conversation_id, path) "
                "INSERT INTO branch_scratch_writes (conversation_id, branch_thread_id, path, message_id, user_id, "
                f"{plain}) SELECT p.conversation_id, %(target)s, p.path, p.message_id, p.user_id, {prefixed} "
                "FROM picked p JOIN copied c ON c.conversation_id = p.conversation_id AND c.path = p.path "
                "ON CONFLICT DO NOTHING",
                {"source": source_thread_id, "target": target_thread_id,
                 "messages": list(messages) if messages is not None else None},
            )
            copied = cur.rowcount or 0
        logger.info("branch_scratch_copied", "Copied a branch's scratch files to its fork", files=copied,
                    answers=None if messages is None else len(messages))
        return copied

    async def delete_conversation(self, user_id: str, conversation_id: str) -> int:
        """Delete every scratch file of one conversation, on every branch."""
        async with self.pool.connection() as conn, conn.transaction():
            cur = await conn.execute(
                "DELETE FROM branch_scratch_files WHERE conversation_id = %s AND user_id = %s",
                (conversation_id, user_id),
            )
            removed = cur.rowcount or 0
            await conn.execute(
                "DELETE FROM branch_scratch_writes WHERE conversation_id = %s AND user_id = %s",
                (conversation_id, user_id),
            )
            await conn.execute(
                "DELETE FROM branch_scratch_imports WHERE conversation_id = %s AND user_id = %s",
                (conversation_id, user_id),
            )
        logger.info("branch_scratch_reaped", "Deleted a conversation's scratch files", files=removed)
        return removed

    async def purge_user(self, user_id: str) -> dict[str, int]:
        """Account deletion: every scratch file the user has, in one transaction."""
        async with self.pool.connection() as conn, conn.transaction():
            files = await conn.execute("DELETE FROM branch_scratch_files WHERE user_id = %s", (user_id,))
            await conn.execute("DELETE FROM branch_scratch_writes WHERE user_id = %s", (user_id,))
            await conn.execute("DELETE FROM branch_scratch_imports WHERE user_id = %s", (user_id,))
        counts = {"branch_scratch_files": files.rowcount or 0}
        logger.info("branch_scratch_purged", "Deleted a user's scratch files", **counts)
        return counts

    # -- the one-shot legacy import (plan 41 §3.7; removed in the next release) --
    async def is_imported(self, scope: ScratchScope) -> bool:
        """Whether this branch's legacy ``files`` state was already imported."""
        async with self.pool.connection() as conn:
            cur = await conn.execute(
                "SELECT 1 FROM branch_scratch_imports WHERE conversation_id = %(conversation_id)s "
                "AND branch_thread_id = %(branch_thread_id)s",
                scope.params(),
            )
            return await cur.fetchone() is not None

    async def import_legacy(
        self, scope: ScratchScope, files: Mapping[str, tuple[bytes, Encoding]], *, agent_slug: str
    ) -> int:
        """Insert the legacy files the branch does not have yet, and mark it imported.

        One transaction, so a crash leaves the branch unmarked and the next use
        tries again. A path already in the store is newer than any checkpoint
        value (it was written after the deploy, or copied from a fork's source)
        and is kept. Returns how many files were inserted.
        """
        inserted = 0
        async with self.pool.connection() as conn, conn.transaction():
            for path, (data, encoding) in files.items():
                self._checked(data, encoding)
                cipher_name, stored = self.cipher.encrypt(data)
                cur = await conn.execute(
                    "INSERT INTO branch_scratch_files (conversation_id, branch_thread_id, path, user_id, "
                    "sha256, size_bytes, encoding, cipher, data, agent_slug) "
                    "VALUES (%(conversation_id)s, %(branch_thread_id)s, %(path)s, %(user_id)s, %(sha256)s, "
                    "%(size)s, %(encoding)s, %(cipher)s, %(data)s, %(agent_slug)s) "
                    "ON CONFLICT (conversation_id, branch_thread_id, path) DO NOTHING",
                    scope.params(path=path, sha256=content_hash(data), size=len(data), encoding=encoding,
                                 cipher=cipher_name, data=stored, agent_slug=agent_slug),
                )
                if cur.rowcount:
                    # No answer is known for a checkpoint value: a fork always takes it.
                    await self._log_write(conn, scope, path, content_hash(data), len(data), encoding,
                                          cipher_name, stored, agent_slug, None)
                inserted += cur.rowcount or 0
            await conn.execute(
                "INSERT INTO branch_scratch_imports (conversation_id, branch_thread_id, user_id, files) "
                "VALUES (%(conversation_id)s, %(branch_thread_id)s, %(user_id)s, %(files)s) "
                "ON CONFLICT (conversation_id, branch_thread_id) DO NOTHING",
                scope.params(files=inserted),
            )
        return inserted


__all__ = [
    "ENCODINGS",
    "BranchScratchStore",
    "Encoding",
    "ScratchEntry",
    "ScratchFile",
    "ScratchFileTooLarge",
    "ScratchScope",
    "content_hash",
]
