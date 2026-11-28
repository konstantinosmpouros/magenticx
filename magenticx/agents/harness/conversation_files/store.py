"""A conversation's files as rows in ``agent_runtime`` (plan 36).

**Every row belongs to one branch** of the conversation (its
``branch_thread_id``, the checkpointer's thread for that branch), so a file one
branch wrote is not on its siblings. A store is bound to one branch when it is
made (``branch=``) and every statement it runs carries it; see
:class:`_BranchConnection`. An edit or a retry starts a branch whose files are
copied from the source branch **as they were at the fork point**
(:meth:`ConversationFileStore.copy_branch`), using the write log below — the
same idea as the checkpointer forking from a checkpoint.

Rows written before branches existed belong to the **legacy** branch ``''``.
The first time a branch touches its files they are copied into it once
(rows only), and ``conversation_file_branches`` records that the branch has
its files; a branch made by a fork is recorded by the fork instead.

The tables, so that a byte is stored once however many paths name it, plus the
canvas documents' history (plan 44) that names the same blobs:

* ``conversation_file_blobs`` — ``(user_id, sha256)`` → the bytes, encrypted
  with the checkpointer's key (:mod:`.cipher`). Content-addressed per user, so
  a fork, a copy or the same report written twice share one blob. Never
  across users: a shared blob would let one tenant learn that another holds a
  given file, and would tie one account's deletion to another's data.
* ``conversation_files`` — ``(conversation_id, branch_thread_id, path)`` → a
  blob: the branch's files as they are now. Small rows; listing, globbing and
  forking never touch a byte of content.
* ``conversation_file_writes`` — append-only: every write of a file, with the
  answer message that made it (``message_id``). What a fork reads to give the
  new branch each file as it was at the fork point.
* ``conversation_file_branches`` — the branches whose files are set up (from
  the legacy rows or from a fork).
* ``conversation_file_versions`` — the append-only versions of a canvas
  document (a presented ``.md`` under ``/conversation/output/``), each naming
  a blob. The logic lives in :mod:`.versions`; the DDL is here because a
  blob's lifetime is decided here: a version keeps its blob alive exactly like
  a file does, and a fork, a reap and a purge treat versions as rows of the
  conversation, in the same transaction as its files.
* ``conversation_file_seen`` — per canvas document, the version the agent
  last saw (plan 44 Phase 4.3), so the next turn's note carries only the
  user's edits since. No bytes; the logic lives in :mod:`.seen`. A row of the
  conversation like the versions: copied on fork, deleted by a reap and a purge.
* ``conversation_file_comments`` — the user's comments on a canvas document
  (plan 44 Phase 4.4): threads anchored to a passage of one version, and
  their replies. The body, the anchor and the resolution note are encrypted
  with the blobs' cipher; the logic lives in :mod:`.comments`. Rows of the
  conversation too: copied on fork (new ids, same threads), deleted by a reap
  and a purge.
* ``conversation_file_suggestions`` — the user's pending suggestion set on a
  canvas document (plan 44 Phase 4.6, Suggesting mode): one row per document,
  the proposed full text on the version it was made on, encrypted with the
  blobs' cipher; the logic lives in :mod:`.suggestions`. Copied on fork,
  deleted by a reap and a purge, like the comments.

A blob lives while any row (a file, a write or a version) names it. The foreign key from rows to blobs is the
guard: a blob still referenced cannot be deleted, so garbage collection can be
optimistic — delete what *looks* unreferenced, and let the constraint refuse
the one a concurrent write just picked up (:meth:`_collect_garbage`).

The service is this table's only reader and writer, so — like memory, skills
and agent definitions — it owns the DDL and creates it on boot.
"""
from __future__ import annotations

import hashlib
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Literal, TypeVar

import psycopg

from core.logging import get_logger
from harness.conversation_files import paths
from harness.conversation_files.cipher import FileCipher, get_file_cipher

logger = get_logger(__name__)

_StoreT = TypeVar("_StoreT", bound="ConversationFileStore")

#: What a write came to. Anything but ``ok`` changed nothing.
WriteOutcome = Literal["ok", "exists", "is_directory", "parent_is_file"]

#: The branch of the rows written before files were branch-scoped. Every other
#: branch copies them once, the first time it touches its files.
LEGACY_BRANCH = ""

#: Tables from before branches get the column (legacy rows: ``''``), then their
#: keys are rebuilt with it — in one block, guarded by whether the files' key
#: already has the column, so a second boot changes nothing. A fresh database
#: is created in the new shape by the statements above and skips the block.
_BRANCH_MIGRATION = (
    *(
        f"ALTER TABLE {table} ADD COLUMN IF NOT EXISTS branch_thread_id text NOT NULL DEFAULT ''"
        for table in ("conversation_files", "conversation_file_versions", "conversation_file_seen",
                      "conversation_file_comments", "conversation_file_suggestions")
    ),
    "ALTER TABLE conversation_file_versions ADD COLUMN IF NOT EXISTS message_id text",
    """
    DO $$
    BEGIN
        IF NOT EXISTS (
            SELECT 1 FROM pg_constraint c
            JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
            WHERE c.conname = 'conversation_files_pkey' AND a.attname = 'branch_thread_id'
        ) THEN
            ALTER TABLE conversation_file_comments DROP CONSTRAINT IF EXISTS conversation_file_comments_version_fk;
            ALTER TABLE conversation_file_suggestions
                DROP CONSTRAINT IF EXISTS conversation_file_suggestions_version_fk;
            ALTER TABLE conversation_files DROP CONSTRAINT conversation_files_pkey,
                ADD PRIMARY KEY (conversation_id, branch_thread_id, path);
            ALTER TABLE conversation_file_versions DROP CONSTRAINT conversation_file_versions_unique,
                ADD CONSTRAINT conversation_file_versions_unique
                UNIQUE (conversation_id, branch_thread_id, path, version);
            ALTER TABLE conversation_file_seen DROP CONSTRAINT conversation_file_seen_pkey,
                ADD PRIMARY KEY (conversation_id, branch_thread_id, path);
            ALTER TABLE conversation_file_suggestions DROP CONSTRAINT conversation_file_suggestions_pkey,
                ADD PRIMARY KEY (conversation_id, branch_thread_id, path);
            ALTER TABLE conversation_file_comments ADD CONSTRAINT conversation_file_comments_version_fk
                FOREIGN KEY (conversation_id, branch_thread_id, path, version)
                REFERENCES conversation_file_versions (conversation_id, branch_thread_id, path, version)
                ON DELETE CASCADE;
            ALTER TABLE conversation_file_suggestions ADD CONSTRAINT conversation_file_suggestions_version_fk
                FOREIGN KEY (conversation_id, branch_thread_id, path, base_version)
                REFERENCES conversation_file_versions (conversation_id, branch_thread_id, path, version)
                ON DELETE CASCADE;
        END IF;
    END $$
    """,
)

#: The comments' and suggestions' keys to the version they sit on, added after
#: the tables and the branch migration rather than inside the CREATE TABLEs:
#: they reference ``conversation_file_versions (…, branch_thread_id, …)``, and
#: on a database from before branches that column exists only once
#: ``_BRANCH_MIGRATION`` has run. Created inline, a table new to that database
#: (the suggestions, on one that never had them) failed its CREATE and the
#: service could not boot. Each key is added only when missing, so a fresh
#: database gets both here, a migrated one keeps the ones the migration re-added,
#: and a second boot changes nothing.
_VERSION_FOREIGN_KEYS = """
    DO $$
    BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'conversation_file_comments_version_fk') THEN
            ALTER TABLE conversation_file_comments ADD CONSTRAINT conversation_file_comments_version_fk
                FOREIGN KEY (conversation_id, branch_thread_id, path, version)
                REFERENCES conversation_file_versions (conversation_id, branch_thread_id, path, version)
                ON DELETE CASCADE;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'conversation_file_suggestions_version_fk') THEN
            ALTER TABLE conversation_file_suggestions ADD CONSTRAINT conversation_file_suggestions_version_fk
                FOREIGN KEY (conversation_id, branch_thread_id, path, base_version)
                REFERENCES conversation_file_versions (conversation_id, branch_thread_id, path, version)
                ON DELETE CASCADE;
        END IF;
    END $$
"""

_DDL = (
    """
    CREATE TABLE IF NOT EXISTS conversation_file_blobs (
        user_id     text NOT NULL,
        sha256      text NOT NULL,
        size_bytes  bigint NOT NULL,
        cipher      text NOT NULL,
        data        bytea NOT NULL,
        created_at  timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (user_id, sha256)
    )
    """,
    # Encrypted bytes do not compress; EXTERNAL skips the futile attempt.
    "ALTER TABLE conversation_file_blobs ALTER COLUMN data SET STORAGE EXTERNAL",
    """
    CREATE TABLE IF NOT EXISTS conversation_files (
        conversation_id  text NOT NULL,
        branch_thread_id text NOT NULL DEFAULT '',
        path             text COLLATE "C" NOT NULL,
        user_id          text NOT NULL,
        sha256           text NOT NULL,
        size_bytes       bigint NOT NULL,
        agent_slug       text NOT NULL,
        source_run_id    text,
        created_at       timestamptz NOT NULL DEFAULT now(),
        updated_at       timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (conversation_id, branch_thread_id, path),
        CONSTRAINT conversation_files_blob_fk FOREIGN KEY (user_id, sha256)
            REFERENCES conversation_file_blobs (user_id, sha256),
        CONSTRAINT conversation_files_path_ck CHECK (
            path ~ '^/(conversation|large_tool_results|conversation_history)/.+'
            AND path !~ '^/conversation/input(/|$)'
        )
    )
    """,
    # Serves the account purge, the blob GC's "still referenced?" probe and
    # the foreign key's own check when a blob is deleted.
    "CREATE INDEX IF NOT EXISTS conversation_files_blob_idx ON conversation_files (user_id, sha256)",
    # Every write of a file, append-only: what a fork reads to give the new
    # branch each file as it was at the fork point. message_id is the answer
    # that wrote it (NULL: a legacy row, or a write no answer made).
    """
    CREATE TABLE IF NOT EXISTS conversation_file_writes (
        id               bigserial PRIMARY KEY,
        conversation_id  text NOT NULL,
        branch_thread_id text NOT NULL,
        path             text COLLATE "C" NOT NULL,
        user_id          text NOT NULL,
        message_id       text,
        sha256           text NOT NULL,
        size_bytes       bigint NOT NULL,
        agent_slug       text NOT NULL,
        created_at       timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT conversation_file_writes_blob_fk FOREIGN KEY (user_id, sha256)
            REFERENCES conversation_file_blobs (user_id, sha256)
    )
    """,
    # A fork's "latest write per path" scan, newest first.
    "CREATE INDEX IF NOT EXISTS conversation_file_writes_branch_idx "
    "ON conversation_file_writes (conversation_id, branch_thread_id, path, id DESC)",
    # The GC probe and the purge.
    "CREATE INDEX IF NOT EXISTS conversation_file_writes_blob_idx ON conversation_file_writes (user_id, sha256)",
    # The branches whose files are set up: copied from the legacy rows on first
    # touch, or from the source branch by a fork.
    """
    CREATE TABLE IF NOT EXISTS conversation_file_branches (
        conversation_id  text NOT NULL,
        branch_thread_id text NOT NULL,
        user_id          text NOT NULL,
        created_at       timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (conversation_id, branch_thread_id)
    )
    """,
    "CREATE INDEX IF NOT EXISTS conversation_file_branches_user_idx ON conversation_file_branches (user_id)",
    # A canvas document's versions (plan 44 §4). Append-only: a row is never
    # updated, and only a reap or a purge deletes one.
    """
    CREATE TABLE IF NOT EXISTS conversation_file_versions (
        id               bigserial PRIMARY KEY,
        user_id          text NOT NULL,
        conversation_id  text NOT NULL,
        branch_thread_id text NOT NULL DEFAULT '',
        path             text COLLATE "C" NOT NULL,
        version          integer NOT NULL,
        sha256           text NOT NULL,
        size_bytes       bigint NOT NULL,
        author           text NOT NULL,
        base_version     integer,
        source_run_id    text,
        message_id       text,
        created_at       timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT conversation_file_versions_unique UNIQUE (conversation_id, branch_thread_id, path, version),
        CONSTRAINT conversation_file_versions_blob_fk FOREIGN KEY (user_id, sha256)
            REFERENCES conversation_file_blobs (user_id, sha256),
        CONSTRAINT conversation_file_versions_author_ck CHECK (author IN ('agent', 'user')),
        CONSTRAINT conversation_file_versions_version_ck CHECK (version >= 1),
        CONSTRAINT conversation_file_versions_path_ck CHECK (path ~ '^/conversation/output/.+[.]md$')
    )
    """,
    # The GC probe, the purge and the foreign key's check, as for the files.
    "CREATE INDEX IF NOT EXISTS conversation_file_versions_blob_idx "
    "ON conversation_file_versions (user_id, sha256)",
    # Which version of each canvas document the agent last saw (plan 44 4.3).
    # Keyed like the files; user_id is on every row so every statement can
    # filter on it and the account purge finds the rows.
    """
    CREATE TABLE IF NOT EXISTS conversation_file_seen (
        conversation_id    text NOT NULL,
        branch_thread_id   text NOT NULL DEFAULT '',
        path               text COLLATE "C" NOT NULL,
        user_id            text NOT NULL,
        agent_seen_version integer NOT NULL,
        updated_at         timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (conversation_id, branch_thread_id, path),
        CONSTRAINT conversation_file_seen_version_ck CHECK (agent_seen_version >= 1),
        CONSTRAINT conversation_file_seen_path_ck CHECK (path ~ '^/conversation/output/.+[.]md$')
    )
    """,
    "CREATE INDEX IF NOT EXISTS conversation_file_seen_user_idx ON conversation_file_seen (user_id)",
    # Comments on a canvas document (plan 44 4.4). A thread (parent_id NULL)
    # has an anchor and a status; a reply has neither, and its parent is a
    # comment of the same conversation (the composite foreign key). The
    # version must exist, so a comment can never name a document the
    # conversation does not have. The text columns hold encrypted bytes.
    """
    CREATE TABLE IF NOT EXISTS conversation_file_comments (
        id               uuid PRIMARY KEY,
        user_id          text NOT NULL,
        conversation_id  text NOT NULL,
        branch_thread_id text NOT NULL DEFAULT '',
        path             text COLLATE "C" NOT NULL,
        version          integer NOT NULL,
        parent_id        uuid,
        cipher          text NOT NULL,
        anchor          bytea,
        body            bytea NOT NULL,
        author          text NOT NULL,
        status          text,
        resolved_by     text,
        resolution_note bytea,
        created_at      timestamptz NOT NULL DEFAULT now(),
        updated_at      timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT conversation_file_comments_conversation_id_key UNIQUE (conversation_id, id),
        CONSTRAINT conversation_file_comments_parent_fk FOREIGN KEY (conversation_id, parent_id)
            REFERENCES conversation_file_comments (conversation_id, id) ON DELETE CASCADE,
        CONSTRAINT conversation_file_comments_author_ck CHECK (author IN ('agent', 'user')),
        CONSTRAINT conversation_file_comments_shape_ck CHECK (
            (parent_id IS NULL) = (anchor IS NOT NULL) AND (parent_id IS NULL) = (status IS NOT NULL)
        ),
        CONSTRAINT conversation_file_comments_status_ck CHECK (status IS NULL OR status IN ('open', 'resolved')),
        CONSTRAINT conversation_file_comments_resolved_ck CHECK (
            resolved_by IS NULL OR (resolved_by IN ('agent', 'user') AND status = 'resolved')
        ),
        CONSTRAINT conversation_file_comments_path_ck CHECK (path ~ '^/conversation/output/.+[.]md$')
    )
    """,
    # A document's comments in order (the list, the per-document thread cap).
    "CREATE INDEX IF NOT EXISTS conversation_file_comments_doc_idx "
    "ON conversation_file_comments (conversation_id, path, created_at)",
    # A thread's replies (the reply cap, the cascade from a deleted thread).
    "CREATE INDEX IF NOT EXISTS conversation_file_comments_parent_idx "
    "ON conversation_file_comments (conversation_id, parent_id) WHERE parent_id IS NOT NULL",
    "CREATE INDEX IF NOT EXISTS conversation_file_comments_user_idx ON conversation_file_comments (user_id)",
    # The user's pending suggestion set on a canvas document (plan 44 4.6):
    # one row per document, the PROPOSED full text (every pending suggestion
    # accepted) on the accepted version it was made on. The version must
    # exist (the foreign key); content holds encrypted bytes (cipher).
    """
    CREATE TABLE IF NOT EXISTS conversation_file_suggestions (
        conversation_id  text NOT NULL,
        branch_thread_id text NOT NULL DEFAULT '',
        path             text COLLATE "C" NOT NULL,
        user_id         text NOT NULL,
        base_version    integer NOT NULL,
        cipher          text NOT NULL,
        content         bytea NOT NULL,
        size_bytes      bigint NOT NULL,
        created_at      timestamptz NOT NULL DEFAULT now(),
        updated_at      timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (conversation_id, branch_thread_id, path),
        CONSTRAINT conversation_file_suggestions_path_ck CHECK (path ~ '^/conversation/output/.+[.]md$')
    )
    """,
    "ALTER TABLE conversation_file_suggestions ALTER COLUMN content SET STORAGE EXTERNAL",
    # The account purge.
    "CREATE INDEX IF NOT EXISTS conversation_file_suggestions_user_idx ON conversation_file_suggestions (user_id)",
    *_BRANCH_MIGRATION,
    _VERSION_FOREIGN_KEYS,
)

_COMMENTS = (
    "COMMENT ON TABLE conversation_files IS "
    "'A conversation branch''s files by virtual path (plan 36). Bytes live in conversation_file_blobs.'",
    "COMMENT ON COLUMN conversation_files.branch_thread_id IS "
    "'The branch the file is on (its checkpoint thread); empty for rows from before branches.'",
    "COMMENT ON TABLE conversation_file_writes IS "
    "'Every write of a conversation file, append-only, with the answer message that made it; forks read it.'",
    "COMMENT ON TABLE conversation_file_branches IS "
    "'The conversation branches whose files are set up (from the legacy rows, or by a fork).'",
    "COMMENT ON COLUMN conversation_files.agent_slug IS "
    "'The agent that last wrote the file. Provenance only; files belong to the conversation.'",
    "COMMENT ON COLUMN conversation_file_blobs.cipher IS "
    "'none, or the LangGraph cipher name (aes) that encrypted data with LANGGRAPH_AES_KEY.'",
    "COMMENT ON TABLE conversation_file_versions IS "
    "'Append-only versions of a canvas document (plan 44). Bytes live in conversation_file_blobs.'",
    "COMMENT ON COLUMN conversation_file_versions.base_version IS "
    "'The version a save was based on (a user save must name the latest); NULL for a first version.'",
    "COMMENT ON TABLE conversation_file_seen IS "
    "'The version of each canvas document the agent last saw (plan 44 4.3); the next turn diffs from it.'",
    "COMMENT ON TABLE conversation_file_comments IS "
    "'Comments on a canvas document (plan 44 4.4): threads anchored to a passage, and replies. "
    "anchor, body and resolution_note are encrypted (cipher).'",
    "COMMENT ON TABLE conversation_file_suggestions IS "
    "'The user''s pending suggestions on a canvas document (plan 44 4.6): the proposed full text on "
    "base_version, not applied until accepted. content is encrypted (cipher).'",
)

_ENTRY_COLUMNS = "path, size_bytes, sha256, agent_slug, updated_at"
_SCOPE = (
    "conversation_id = %(conversation_id)s AND branch_thread_id = %(branch)s AND user_id = %(user_id)s"
)

_GC_ATTEMPTS = 3


@dataclass(frozen=True)
class FileEntry:
    """A file without its bytes — what listing and globbing work from."""

    path: str
    size: int
    sha256: str
    agent_slug: str
    updated_at: datetime


def _entry(row: dict[str, Any]) -> FileEntry:
    return FileEntry(
        path=row["path"],
        size=int(row["size_bytes"]),
        sha256=row["sha256"],
        agent_slug=row["agent_slug"],
        updated_at=row["updated_at"],
    )


def _scope(user_id: str, conversation_id: str, **extra: Any) -> dict[str, Any]:
    return {"user_id": user_id, "conversation_id": conversation_id, **extra}


class BranchRequired(RuntimeError):
    """A branch-scoped read or write on a store made without a branch."""


class _BranchConnection:
    """A pooled connection bound to one branch and one writer.

    Every statement sent with named parameters gets ``%(branch)s`` (the
    store's branch) and ``%(message_id)s`` (the answer that writes, or None),
    unless it names them itself. So no query can forget the branch: one that
    reads ``branch_thread_id = %(branch)s`` always has it, and the SQL stays
    explicit about the column.
    """

    def __init__(self, conn: Any, branch: str, message_id: str | None) -> None:
        self._conn = conn
        self._defaults = {"branch": branch, "message_id": message_id}

    async def execute(self, query: str, params: Any = None) -> Any:
        if isinstance(params, dict):
            params = {**self._defaults, **params}
        return await self._conn.execute(query, params)

    def transaction(self) -> Any:
        return self._conn.transaction()


class ConversationFileStore:
    """Reads and writes one user's files on one branch of a conversation.

    Bound to a branch (``branch``, the branch's checkpoint thread) and to the
    answer message that writes (``message_id``, recorded in the write log).
    Every statement filters on ``conversation_id``, the branch and
    ``user_id``, so a wrong conversation id from a caller can never reach
    another user's rows, nor another branch's. A store made without a branch
    serves only what spans branches: setup, the reap, the purge.
    Paths are expected already normalised (:func:`paths.normalise`).
    """

    def __init__(
        self, pool: Any, cipher: FileCipher | None = None, *,
        branch: str | None = None, message_id: str | None = None,
    ) -> None:
        self._pool = pool
        self._cipher = cipher or get_file_cipher()
        self._branch = branch
        self._message_id = message_id

    @property
    def branch(self) -> str | None:
        return self._branch

    def sibling(self, store_class: type[_StoreT]) -> _StoreT:
        """Another store over the same pool, cipher, branch and writer.

        How a run's canvas tools get their version, comment and suggestion
        stores from its file store: the branch comes along, so a tool cannot
        reach another branch's documents.
        """
        return store_class(self._pool, self._cipher, branch=self._branch, message_id=self._message_id)

    @asynccontextmanager
    async def _connect(self, user_id: str, conversation_id: str) -> AsyncIterator[_BranchConnection]:
        """A connection bound to this store's branch, its files set up first.

        A branch that has never had its files set up gets the legacy rows
        (:meth:`_set_up_branch`) — one cheap lookup once it has.
        """
        if self._branch is None:
            raise BranchRequired("This store was made without a branch.")
        async with self._pool.connection() as raw:
            conn = _BranchConnection(raw, self._branch, self._message_id)
            if self._branch != LEGACY_BRANCH:
                await self._set_up_branch(conn, user_id, conversation_id, self._branch)
            yield conn

    async def setup(self) -> None:
        """Create the tables if absent — ``agent_runtime`` has no alembic chain."""
        async with self._pool.connection() as conn:
            for statement in (*_DDL, *_COMMENTS):
                await conn.execute(statement)

    # -- reads ---------------------------------------------------------------
    async def list_files(self, user_id: str, conversation_id: str, directory: str = "/") -> list[FileEntry]:
        """Every file at ``directory`` or below it, in path order, without bytes."""
        lower, upper = paths.children_range(directory)
        async with self._connect(user_id, conversation_id) as conn:
            cur = await conn.execute(
                f"SELECT {_ENTRY_COLUMNS} FROM conversation_files WHERE {_SCOPE} "
                "AND (path = %(path)s OR (path >= %(lower)s AND path < %(upper)s)) ORDER BY path",
                _scope(user_id, conversation_id, path=directory, lower=lower, upper=upper),
            )
            return [_entry(row) for row in await cur.fetchall()]

    async def stat(self, user_id: str, conversation_id: str, path: str) -> FileEntry | None:
        async with self._connect(user_id, conversation_id) as conn:
            cur = await conn.execute(
                f"SELECT {_ENTRY_COLUMNS} FROM conversation_files WHERE {_SCOPE} AND path = %(path)s",
                _scope(user_id, conversation_id, path=path),
            )
            row = await cur.fetchone()
        return _entry(row) if row else None

    async def read(self, user_id: str, conversation_id: str, path: str) -> bytes | None:
        return (await self.read_many(user_id, conversation_id, [path])).get(path)

    async def read_many(self, user_id: str, conversation_id: str, file_paths: list[str]) -> dict[str, bytes]:
        """The plaintext of each named file that exists, keyed by path."""
        if not file_paths:
            return {}
        async with self._connect(user_id, conversation_id) as conn:
            cur = await conn.execute(
                "SELECT f.path, b.cipher, b.data FROM conversation_files f "
                "JOIN conversation_file_blobs b ON b.user_id = f.user_id AND b.sha256 = f.sha256 "
                "WHERE f.conversation_id = %(conversation_id)s AND f.branch_thread_id = %(branch)s "
                "AND f.user_id = %(user_id)s AND f.path = ANY(%(paths)s)",
                _scope(user_id, conversation_id, paths=list(file_paths)),
            )
            rows = await cur.fetchall()
        return {row["path"]: self._cipher.decrypt(row["cipher"], bytes(row["data"])) for row in rows}

    # -- writes --------------------------------------------------------------
    async def create(
        self, user_id: str, conversation_id: str, path: str, data: bytes, *,
        agent_slug: str, run_id: str | None = None,
    ) -> WriteOutcome:
        """Write a new file; never replaces one (``exists`` instead)."""
        outcome: WriteOutcome = "exists"
        async with self._connect(user_id, conversation_id) as conn, conn.transaction():
            conflict = await self._conflict(conn, user_id, conversation_id, path, allow_existing=False)
            if conflict is not None:
                return conflict
            sha256 = await self._save_blob(conn, user_id, data)
            cur = await conn.execute(
                "INSERT INTO conversation_files "
                "(conversation_id, branch_thread_id, path, user_id, sha256, size_bytes, agent_slug, source_run_id) "
                "VALUES (%(conversation_id)s, %(branch)s, %(path)s, %(user_id)s, %(sha256)s, %(size)s, "
                "%(agent_slug)s, %(run_id)s) "
                "ON CONFLICT (conversation_id, branch_thread_id, path) DO NOTHING RETURNING path",
                _scope(user_id, conversation_id, path=path, sha256=sha256, size=len(data),
                       agent_slug=agent_slug, run_id=run_id),
            )
            if await cur.fetchone() is None:
                # A concurrent write took the path first; drop the blob we added.
                raise psycopg.Rollback()
            await self._log_write(conn, user_id, conversation_id, path, sha256, len(data), agent_slug)
            outcome = "ok"
        return outcome

    async def replace(
        self, user_id: str, conversation_id: str, path: str, data: bytes, *,
        agent_slug: str, run_id: str | None = None,
    ) -> WriteOutcome:
        """Write a file, replacing whatever was at ``path``."""
        async with self._connect(user_id, conversation_id) as conn, conn.transaction():
            conflict = await self._conflict(conn, user_id, conversation_id, path, allow_existing=True)
            if conflict is not None:
                return conflict
            cur = await conn.execute(
                f"SELECT sha256 FROM conversation_files WHERE {_SCOPE} AND path = %(path)s FOR UPDATE",
                _scope(user_id, conversation_id, path=path),
            )
            previous = await cur.fetchone()
            sha256 = await self._save_blob(conn, user_id, data)
            await conn.execute(
                "INSERT INTO conversation_files "
                "(conversation_id, branch_thread_id, path, user_id, sha256, size_bytes, agent_slug, source_run_id) "
                "VALUES (%(conversation_id)s, %(branch)s, %(path)s, %(user_id)s, %(sha256)s, %(size)s, "
                "%(agent_slug)s, %(run_id)s) "
                "ON CONFLICT (conversation_id, branch_thread_id, path) DO UPDATE SET sha256 = EXCLUDED.sha256, "
                "size_bytes = EXCLUDED.size_bytes, agent_slug = EXCLUDED.agent_slug, "
                "source_run_id = EXCLUDED.source_run_id, updated_at = now()",
                _scope(user_id, conversation_id, path=path, sha256=sha256, size=len(data),
                       agent_slug=agent_slug, run_id=run_id),
            )
            if previous is None or previous["sha256"] != sha256:
                await self._log_write(conn, user_id, conversation_id, path, sha256, len(data), agent_slug)
            if previous is not None and previous["sha256"] != sha256:
                await self._collect_garbage(conn, user_id, [previous["sha256"]])
        return "ok"

    async def edit(
        self, user_id: str, conversation_id: str, path: str,
        transform: Callable[[bytes], bytes | None], *,
        agent_slug: str, run_id: str | None = None,
    ) -> bool:
        """Read-modify-write one file under a row lock. False when it does not exist.

        ``transform`` gets the current bytes and returns the new ones, or None
        to leave the file as it is. The lock makes two parallel edits (two
        sub-agents on one file) apply one after the other instead of the second
        silently undoing the first.
        """
        async with self._connect(user_id, conversation_id) as conn, conn.transaction():
            cur = await conn.execute(
                "SELECT f.sha256, b.cipher, b.data FROM conversation_files f "
                "JOIN conversation_file_blobs b ON b.user_id = f.user_id AND b.sha256 = f.sha256 "
                "WHERE f.conversation_id = %(conversation_id)s AND f.branch_thread_id = %(branch)s "
                "AND f.user_id = %(user_id)s AND f.path = %(path)s FOR UPDATE OF f",
                _scope(user_id, conversation_id, path=path),
            )
            row = await cur.fetchone()
            if row is None:
                return False
            updated = transform(self._cipher.decrypt(row["cipher"], bytes(row["data"])))
            if updated is None:
                return True
            sha256 = await self._save_blob(conn, user_id, updated)
            if sha256 == row["sha256"]:
                return True
            await conn.execute(
                f"UPDATE conversation_files SET sha256 = %(sha256)s, size_bytes = %(size)s, "
                f"agent_slug = %(agent_slug)s, source_run_id = %(run_id)s, updated_at = now() "
                f"WHERE {_SCOPE} AND path = %(path)s",
                _scope(user_id, conversation_id, path=path, sha256=sha256, size=len(updated),
                       agent_slug=agent_slug, run_id=run_id),
            )
            await self._log_write(conn, user_id, conversation_id, path, sha256, len(updated), agent_slug)
            await self._collect_garbage(conn, user_id, [row["sha256"]])
        return True

    # -- branches ------------------------------------------------------------
    async def copy_branch(
        self, user_id: str, conversation_id: str, source_branch: str, messages: list[str]
    ) -> int:
        """Set up this store's branch as a fork of ``source_branch`` at the fork point.

        ``messages`` are the answers on the path from the root to the fork
        point. For every path, the branch gets the source's latest write made
        by one of them (or by no answer: a legacy row, a user save the bridge
        could not place) — so what the source wrote after the fork point stays
        there, however the source looks now. The canvas documents' versions
        made by those answers come too, with the comments, the suggestions and
        the seen markers on them.

        Rows only, no bytes. Idempotent: a branch whose files are already set
        up (a retried seed) is left alone. Returns the number of files copied.
        """
        if self._branch in (None, LEGACY_BRANCH) or source_branch == self._branch:
            raise BranchRequired("A fork copies into a branch of its own.")
        async with self._pool.connection() as raw, raw.transaction():
            conn = _BranchConnection(raw, self._branch, self._message_id)
            # The source's own files first: a branch never touched since
            # branches began still has them only as legacy rows.
            if source_branch != LEGACY_BRANCH:
                await self._set_up_branch(conn, user_id, conversation_id, source_branch)
            if not await self._claim_branch(conn, user_id, conversation_id, self._branch):
                return 0
            copied = await self._copy_rows(
                conn, user_id, source=(conversation_id, source_branch),
                target=(conversation_id, self._branch), messages=messages,
            )
        logger.info("conversation_files_branched", "Gave a new branch its files as they were at the fork point",
                    files=copied, answers=len(messages))
        return copied

    async def _set_up_branch(self, conn: _BranchConnection, user_id: str, conversation_id: str,
                             branch: str) -> None:
        """Give ``branch`` the legacy rows the first time it touches its files.

        A lookup once the branch is set up. The claim and the copy are one
        transaction, so two first touches at once copy once.
        """
        cur = await conn.execute(
            "SELECT 1 FROM conversation_file_branches "
            "WHERE conversation_id = %(conversation_id)s AND branch_thread_id = %(target)s",
            {"conversation_id": conversation_id, "target": branch},
        )
        if await cur.fetchone() is not None:
            return
        async with conn.transaction():
            if await self._claim_branch(conn, user_id, conversation_id, branch):
                copied = await self._copy_rows(conn, user_id, source=(conversation_id, LEGACY_BRANCH),
                                               target=(conversation_id, branch), messages=None)
                if copied:
                    logger.info("conversation_files_legacy_imported",
                                "Gave a branch the files written before branches", files=copied)

    async def _claim_branch(self, conn: _BranchConnection, user_id: str, conversation_id: str,
                            branch: str) -> bool:
        """Record that ``branch`` has its files. False when it already had them."""
        cur = await conn.execute(
            "INSERT INTO conversation_file_branches (conversation_id, branch_thread_id, user_id) "
            "VALUES (%(conversation_id)s, %(target)s, %(user_id)s) ON CONFLICT DO NOTHING RETURNING 1",
            {"conversation_id": conversation_id, "target": branch, "user_id": user_id},
        )
        return await cur.fetchone() is not None

    async def _copy_rows(
        self, conn: _BranchConnection, user_id: str, *,
        source: tuple[str, str], target: tuple[str, str], messages: list[str] | None,
    ) -> int:
        """Copy one branch's files, versions, comments, suggestions and seen markers to another.

        ``messages`` None copies every current file and version (the legacy
        rows, or a whole branch); a list keeps only what those answers (or no
        answer) wrote, each file as of its latest such write. The target's
        write log gets a row per copied file with the original ``message_id``,
        so a fork of the target cuts correctly too. Rows the target already
        has are kept. Runs inside the caller's transaction.
        """
        params = {"user_id": user_id, "src_conv": source[0], "src_branch": source[1],
                  "dst_conv": target[0], "dst_branch": target[1], "messages": messages}
        if messages is None or source[1] == LEGACY_BRANCH:
            # The source's files as they are now: a whole copy, or the legacy
            # rows, which have no log (no answer wrote them on a branch).
            picked = (
                "SELECT path, sha256, size_bytes, agent_slug, source_run_id, NULL::text AS message_id, "
                "created_at, updated_at FROM conversation_files "
                "WHERE conversation_id = %(src_conv)s AND branch_thread_id = %(src_branch)s "
                "AND user_id = %(user_id)s"
            )
        else:
            # Each path's latest write by an answer on the path to the fork point.
            picked = (
                "SELECT DISTINCT ON (path) path, sha256, size_bytes, agent_slug, NULL::text AS source_run_id, "
                "message_id, created_at, created_at AS updated_at FROM conversation_file_writes "
                "WHERE conversation_id = %(src_conv)s AND branch_thread_id = %(src_branch)s "
                "AND user_id = %(user_id)s "
                "AND (message_id IS NULL OR message_id = ANY(%(messages)s)) ORDER BY path, id DESC"
            )
        cur = await conn.execute(
            f"WITH picked AS ({picked}), "
            "copied AS ("
            "INSERT INTO conversation_files (conversation_id, branch_thread_id, path, user_id, sha256, size_bytes, "
            "agent_slug, source_run_id, created_at, updated_at) "
            "SELECT %(dst_conv)s, %(dst_branch)s, path, %(user_id)s, sha256, size_bytes, agent_slug, source_run_id, "
            "created_at, updated_at FROM picked "
            "ON CONFLICT (conversation_id, branch_thread_id, path) DO NOTHING RETURNING path) "
            "INSERT INTO conversation_file_writes (conversation_id, branch_thread_id, path, user_id, message_id, "
            "sha256, size_bytes, agent_slug, created_at) "
            "SELECT %(dst_conv)s, %(dst_branch)s, p.path, %(user_id)s, p.message_id, p.sha256, p.size_bytes, "
            "p.agent_slug, p.created_at FROM picked p JOIN copied c ON c.path = p.path",
            params,
        )
        copied = cur.rowcount or 0
        # The documents' versions those answers made, numbers kept.
        await conn.execute(
            "INSERT INTO conversation_file_versions (user_id, conversation_id, branch_thread_id, path, version, "
            "sha256, size_bytes, author, base_version, source_run_id, message_id, created_at) "
            "SELECT user_id, %(dst_conv)s, %(dst_branch)s, path, version, sha256, size_bytes, author, base_version, "
            "source_run_id, message_id, created_at FROM conversation_file_versions "
            "WHERE conversation_id = %(src_conv)s AND branch_thread_id = %(src_branch)s AND user_id = %(user_id)s "
            "AND (%(messages)s::text[] IS NULL OR message_id IS NULL OR message_id = ANY(%(messages)s)) "
            "ON CONFLICT (conversation_id, branch_thread_id, path, version) DO NOTHING",
            params,
        )
        # The comments on the versions that came: threads, then the replies of
        # the threads that came. A copy's id is derived from the target and the
        # original, so a retried copy finds its rows and a reply its thread.
        new_id = "md5(%(dst_conv)s || ':' || %(dst_branch)s || ':' || {column}::text)::uuid"
        for replies in (False, True):
            await conn.execute(
                "INSERT INTO conversation_file_comments (id, user_id, conversation_id, branch_thread_id, path, "
                "version, parent_id, cipher, anchor, body, author, status, resolved_by, resolution_note, "
                "created_at, updated_at) "
                f"SELECT {new_id.format(column='c.id')}, c.user_id, %(dst_conv)s, %(dst_branch)s, c.path, "
                f"c.version, {'NULL' if not replies else new_id.format(column='c.parent_id')}, c.cipher, c.anchor, "
                "c.body, c.author, c.status, c.resolved_by, c.resolution_note, c.created_at, c.updated_at "
                "FROM conversation_file_comments c "
                "JOIN conversation_file_versions v ON v.conversation_id = %(dst_conv)s "
                "AND v.branch_thread_id = %(dst_branch)s AND v.path = c.path AND v.version = c.version "
                "WHERE c.conversation_id = %(src_conv)s AND c.branch_thread_id = %(src_branch)s "
                f"AND c.user_id = %(user_id)s AND c.parent_id IS {'NOT ' if replies else ''}NULL "
                + ("AND EXISTS (SELECT 1 FROM conversation_file_comments t "
                   f"WHERE t.conversation_id = %(dst_conv)s AND t.id = {new_id.format(column='c.parent_id')}) "
                   if replies else "")
                + "ON CONFLICT (id) DO NOTHING",
                params,
            )
        # The pending suggestions whose base version came.
        await conn.execute(
            "INSERT INTO conversation_file_suggestions (conversation_id, branch_thread_id, path, user_id, "
            "base_version, cipher, content, size_bytes, created_at, updated_at) "
            "SELECT %(dst_conv)s, %(dst_branch)s, s.path, s.user_id, s.base_version, s.cipher, s.content, "
            "s.size_bytes, s.created_at, s.updated_at FROM conversation_file_suggestions s "
            "JOIN conversation_file_versions v ON v.conversation_id = %(dst_conv)s "
            "AND v.branch_thread_id = %(dst_branch)s AND v.path = s.path AND v.version = s.base_version "
            "WHERE s.conversation_id = %(src_conv)s AND s.branch_thread_id = %(src_branch)s "
            "AND s.user_id = %(user_id)s "
            "ON CONFLICT (conversation_id, branch_thread_id, path) DO NOTHING",
            params,
        )
        # What the agent had seen, never past the versions the target has: a
        # marker on a version that stayed behind would hide the user's edits.
        await conn.execute(
            "INSERT INTO conversation_file_seen (conversation_id, branch_thread_id, path, user_id, "
            "agent_seen_version, updated_at) "
            "SELECT %(dst_conv)s, %(dst_branch)s, s.path, s.user_id, "
            "least(s.agent_seen_version, v.latest), s.updated_at FROM conversation_file_seen s "
            "JOIN (SELECT path, max(version) AS latest FROM conversation_file_versions "
            "WHERE conversation_id = %(dst_conv)s AND branch_thread_id = %(dst_branch)s GROUP BY path) v "
            "ON v.path = s.path "
            "WHERE s.conversation_id = %(src_conv)s AND s.branch_thread_id = %(src_branch)s "
            "AND s.user_id = %(user_id)s "
            "ON CONFLICT (conversation_id, branch_thread_id, path) DO NOTHING",
            params,
        )
        return copied

    # -- whole conversations -------------------------------------------------
    async def copy_conversation(
        self, user_id: str, source_id: str, target_id: str, *, source_branch: str, messages: list[str]
    ) -> int:
        """Give a forked conversation the files of the branch it was forked from, at the fork point.

        ``source_branch`` is the branch of the message the fork starts after
        and ``messages`` the answers on its path up to there, cut exactly as
        :meth:`copy_branch` cuts. The files land in the target's legacy
        branch, so whichever branch the new conversation grows gets them on
        first touch. Rows only, no bytes; rows the target already has are
        kept, so a retried copy changes nothing. Returns the number of files
        copied.
        """
        async with self._pool.connection() as raw, raw.transaction():
            conn = _BranchConnection(raw, LEGACY_BRANCH, None)
            if source_branch != LEGACY_BRANCH:
                await self._set_up_branch(conn, user_id, source_id, source_branch)
            copied = await self._copy_rows(conn, user_id, source=(source_id, source_branch),
                                           target=(target_id, LEGACY_BRANCH), messages=messages)
        logger.info("conversation_files_copied", "Copied a conversation branch's files to its fork",
                    files=copied, answers=len(messages))
        return copied

    async def delete_conversation(self, user_id: str, conversation_id: str) -> tuple[int, int]:
        """Delete every file, write, document version, seen marker, comment and suggestion of one
        conversation, on every branch.

        Returns ``(files, bytes)`` for the files. The rest goes in the same
        transaction, and the blobs any of them named go with them.
        """
        # Every branch of the conversation, so not the branch-bound scope.
        every_branch = "conversation_id = %(conversation_id)s AND user_id = %(user_id)s"
        scope = _scope(user_id, conversation_id)
        async with self._pool.connection() as conn, conn.transaction():
            cur = await conn.execute(
                f"DELETE FROM conversation_files WHERE {every_branch} RETURNING sha256, size_bytes", scope,
            )
            rows = await cur.fetchall()
            writes = await conn.execute(
                f"DELETE FROM conversation_file_writes WHERE {every_branch} RETURNING sha256", scope)
            write_rows = await writes.fetchall()
            # Before the versions they name (the cascade would take them anyway).
            await conn.execute(f"DELETE FROM conversation_file_comments WHERE {every_branch}", scope)
            await conn.execute(f"DELETE FROM conversation_file_suggestions WHERE {every_branch}", scope)
            versions = await conn.execute(
                f"DELETE FROM conversation_file_versions WHERE {every_branch} RETURNING sha256", scope,
            )
            version_rows = await versions.fetchall()
            await conn.execute(f"DELETE FROM conversation_file_seen WHERE {every_branch}", scope)
            await conn.execute(f"DELETE FROM conversation_file_branches WHERE {every_branch}", scope)
            named = ({row["sha256"] for row in rows} | {row["sha256"] for row in write_rows}
                     | {row["sha256"] for row in version_rows})
            await self._collect_garbage(conn, user_id, sorted(named))
        removed = sum(int(row["size_bytes"]) for row in rows)
        logger.info("conversation_files_reaped", "Deleted a conversation's files",
                    files=len(rows), versions=len(version_rows), bytes=removed)
        return len(rows), removed

    async def purge_user(self, user_id: str) -> dict[str, int]:
        """Account deletion: every file, write, branch record, version, seen marker, comment, suggestion
        and blob the user has, in one transaction."""
        async with self._pool.connection() as conn, conn.transaction():
            files = await conn.execute("DELETE FROM conversation_files WHERE user_id = %s", (user_id,))
            writes = await conn.execute("DELETE FROM conversation_file_writes WHERE user_id = %s", (user_id,))
            branches = await conn.execute("DELETE FROM conversation_file_branches WHERE user_id = %s", (user_id,))
            comments = await conn.execute("DELETE FROM conversation_file_comments WHERE user_id = %s", (user_id,))
            suggestions = await conn.execute(
                "DELETE FROM conversation_file_suggestions WHERE user_id = %s", (user_id,))
            versions = await conn.execute("DELETE FROM conversation_file_versions WHERE user_id = %s", (user_id,))
            seen = await conn.execute("DELETE FROM conversation_file_seen WHERE user_id = %s", (user_id,))
            blobs = await conn.execute("DELETE FROM conversation_file_blobs WHERE user_id = %s", (user_id,))
        counts = {
            "conversation_files": files.rowcount or 0,
            "conversation_file_writes": writes.rowcount or 0,
            "conversation_file_branches": branches.rowcount or 0,
            "conversation_file_versions": versions.rowcount or 0,
            "conversation_file_seen": seen.rowcount or 0,
            "conversation_file_comments": comments.rowcount or 0,
            "conversation_file_suggestions": suggestions.rowcount or 0,
            "conversation_file_blobs": blobs.rowcount or 0,
        }
        logger.info("conversation_files_purged", "Deleted a user's conversation files", **counts)
        return counts

    # -- internals -----------------------------------------------------------
    async def _log_write(
        self, conn: _BranchConnection, user_id: str, conversation_id: str, path: str,
        sha256: str, size: int, agent_slug: str,
    ) -> None:
        """Append one write to the branch's log, inside the caller's transaction (the fork cut reads it)."""
        await conn.execute(
            "INSERT INTO conversation_file_writes (conversation_id, branch_thread_id, path, user_id, message_id, "
            "sha256, size_bytes, agent_slug) VALUES (%(conversation_id)s, %(branch)s, %(path)s, %(user_id)s, "
            "%(message_id)s, %(sha256)s, %(size)s, %(agent_slug)s)",
            _scope(user_id, conversation_id, path=path, sha256=sha256, size=size, agent_slug=agent_slug),
        )

    async def _conflict(
        self, conn: Any, user_id: str, conversation_id: str, path: str, *, allow_existing: bool
    ) -> WriteOutcome | None:
        """Why ``path`` cannot take a file: an ancestor is a file, it is a
        directory, or (unless ``allow_existing``) it is already a file."""
        lower, upper = paths.children_range(path)
        probes = paths.ancestors(path) + ([] if allow_existing else [path])
        cur = await conn.execute(
            f"SELECT path FROM conversation_files WHERE {_SCOPE} "
            "AND (path = ANY(%(probes)s) OR (path >= %(lower)s AND path < %(upper)s)) LIMIT 1",
            _scope(user_id, conversation_id, probes=probes, lower=lower, upper=upper),
        )
        row = await cur.fetchone()
        if row is None:
            return None
        if row["path"] == path:
            return "exists"
        return "is_directory" if row["path"].startswith(lower) else "parent_is_file"

    async def _save_blob(self, conn: Any, user_id: str, data: bytes) -> str:
        """Make sure the blob for ``data`` exists and stays until this commit.

        An existing blob is locked ``FOR KEY SHARE`` — the lock a foreign key
        takes — so a concurrent garbage collection cannot delete it between now
        and the row that will name it. Only a new blob is encrypted and sent.
        """
        sha256 = hashlib.sha256(data).hexdigest()
        cur = await conn.execute(
            "SELECT 1 FROM conversation_file_blobs WHERE user_id = %s AND sha256 = %s FOR KEY SHARE",
            (user_id, sha256),
        )
        if await cur.fetchone() is None:
            cipher, stored = self._cipher.encrypt(data)
            await conn.execute(
                "INSERT INTO conversation_file_blobs (user_id, sha256, size_bytes, cipher, data) "
                "VALUES (%s, %s, %s, %s, %s) "
                # DO UPDATE, not DO NOTHING: it locks a blob a racing writer just
                # added, which DO NOTHING would leave unprotected.
                "ON CONFLICT (user_id, sha256) DO UPDATE SET size_bytes = EXCLUDED.size_bytes",
                (user_id, sha256, len(data), cipher, stored),
            )
        return sha256

    async def _collect_garbage(self, conn: Any, user_id: str, sha256s: list[str]) -> None:
        """Delete the blobs among ``sha256s`` that no file, no write and no version names any more.

        Runs in a savepoint inside the caller's transaction, so it sees the
        caller's own deletes. When a concurrent write picks a blob up between
        the "unreferenced?" probe and the delete, the foreign key refuses the
        delete; the retry is a fresh statement that sees the new reference and
        leaves that blob alone.
        """
        if not sha256s:
            return
        for _ in range(_GC_ATTEMPTS):
            try:
                async with conn.transaction():
                    await conn.execute(
                        "DELETE FROM conversation_file_blobs b "
                        "WHERE b.user_id = %s AND b.sha256 = ANY(%s) AND NOT EXISTS ("
                        "SELECT 1 FROM conversation_files f WHERE f.user_id = b.user_id AND f.sha256 = b.sha256"
                        ") AND NOT EXISTS ("
                        "SELECT 1 FROM conversation_file_writes w WHERE w.user_id = b.user_id AND w.sha256 = b.sha256"
                        ") AND NOT EXISTS ("
                        "SELECT 1 FROM conversation_file_versions v "
                        "WHERE v.user_id = b.user_id AND v.sha256 = b.sha256)",
                        (user_id, sha256s),
                    )
                return
            except psycopg.errors.ForeignKeyViolation:
                continue
        logger.warning("conversation_blob_gc_deferred",
                       "Left blobs in place that concurrent writes kept referencing", blobs=len(sha256s))
