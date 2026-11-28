"""A conversation's files, kept per branch (step 2 of "a branch sees files from other branches").

Pinned here, against Postgres:

* **isolation** — a store bound to one branch never sees another's files;
* **the fork cut** — an edit or a retry gives the new branch each file as of
  the latest write an answer *up to the fork point* made, so the answer the
  edit replaces leaves nothing behind, and a fork of a fork cuts the same way;
* **the documents come along on the same cut** — versions, the comments and
  suggestions on them, and the seen marker clamped to what came;
* **legacy rows** — files from before branches reach every branch once;
* **the boot migration** — tables in the old shape get the branch column and
  keys, their rows becoming the legacy branch.

Needs ``CONVERSATION_FILES_TEST_DSN`` (see ``test_conversation_file_store.py``);
skipped otherwise.
"""
from __future__ import annotations

import asyncio
import importlib
import os
import sys
import uuid

import psycopg
import pytest
import pytest_asyncio
from psycopg import conninfo, sql
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

pytestmark = pytest.mark.asyncio

DSN = os.environ.get("CONVERSATION_FILES_TEST_DSN")
REPORT = "/conversation/output/report.md"
LATER = "/conversation/output/later.md"


@pytest.fixture(scope="module")
def event_loop_policy():
    """psycopg's async mode cannot run on Windows' default Proactor loop."""
    if sys.platform == "win32":
        return asyncio.WindowsSelectorEventLoopPolicy()
    return asyncio.DefaultEventLoopPolicy()


@pytest_asyncio.fixture
async def pg_pool(agents_service):
    if not DSN:
        pytest.skip("CONVERSATION_FILES_TEST_DSN is not set")
    database = f"branch_files_test_{uuid.uuid4().hex[:8]}"
    async with await psycopg.AsyncConnection.connect(DSN, autocommit=True) as admin:
        await admin.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(database)))
    pool = AsyncConnectionPool(conninfo.make_conninfo(DSN, dbname=database), min_size=1, max_size=4, open=False,
                               kwargs={"autocommit": True, "row_factory": dict_row, "prepare_threshold": None})
    await pool.open()
    try:
        yield pool
    finally:
        await pool.close()
        async with await psycopg.AsyncConnection.connect(DSN, autocommit=True) as admin:
            await admin.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(database)))


@pytest.fixture
def stores(pg_pool):
    """``stores(cls, branch, answer)``: a store of ``cls`` on one branch, writing as one answer."""
    cipher = importlib.import_module("harness.conversation_files.cipher").FileCipher(None)

    def make(cls, branch, answer=None):
        return cls(pg_pool, cipher, branch=branch, message_id=answer)

    return make


def _mod(name):
    return importlib.import_module(f"harness.conversation_files.{name}")


@pytest_asyncio.fixture
async def files(stores):
    """``files(branch, answer)``: a comment store (it has every file and document method)."""
    comments = _mod("comments").DocumentCommentStore
    await stores(comments, "b1").setup()
    return lambda branch, answer=None: stores(comments, branch, answer)


async def _paths(store, conversation="c1"):
    return [entry.path for entry in await store.list_files("u1", conversation, "/")]


# ---------------------------------------------------------------------------
# Isolation and the fork cut
# ---------------------------------------------------------------------------
async def test_a_branch_sees_only_its_own_files(files):
    await files("b1", "a1").create("u1", "c1", REPORT, b"one", agent_slug="omni")

    assert await _paths(files("b1")) == [REPORT]
    assert await _paths(files("b2")) == []
    assert await files("b2").read("u1", "c1", REPORT) is None


async def test_a_store_without_a_branch_serves_only_what_spans_branches(pg_pool, files):
    unbound = _mod("store").ConversationFileStore(pg_pool)
    with pytest.raises(_mod("store").BranchRequired):
        await unbound.list_files("u1", "c1", "/")
    await files("b1").create("u1", "c1", REPORT, b"x", agent_slug="omni")
    assert (await unbound.delete_conversation("u1", "c1"))[0] == 1


async def test_a_fork_cuts_at_the_fork_point(files):
    await files("b1", "a1").create("u1", "c1", REPORT, b"v1", agent_slug="omni")
    await files("b1", "a2").replace("u1", "c1", REPORT, b"v2", agent_slug="omni")
    await files("b1", "a2").create("u1", "c1", LATER, b"later", agent_slug="omni")

    # Edit the message a2 answered: the new branch forks at a1.
    assert await files("b2").copy_branch("u1", "c1", "b1", ["a1"]) == 1
    assert await _paths(files("b2")) == [REPORT]
    assert await files("b2").read("u1", "c1", REPORT) == b"v1"
    # A retry of a later message forks after a2: everything comes.
    await files("b3").copy_branch("u1", "c1", "b1", ["a1", "a2"])
    assert await files("b3").read("u1", "c1", REPORT) == b"v2"
    assert await _paths(files("b3")) == [LATER, REPORT]
    # The source is untouched.
    assert await files("b1").read("u1", "c1", REPORT) == b"v2"


async def test_a_fork_of_a_fork_cuts_on_the_original_writers(files):
    await files("b1", "a1").create("u1", "c1", REPORT, b"v1", agent_slug="omni")
    await files("b2").copy_branch("u1", "c1", "b1", ["a1"])
    await files("b2", "a3").replace("u1", "c1", REPORT, b"v3", agent_slug="omni")

    # The copied row keeps a1 as its writer, so a fork of b2 at a1 still has v1.
    await files("b4").copy_branch("u1", "c1", "b2", ["a1"])
    await files("b5").copy_branch("u1", "c1", "b2", ["a1", "a3"])
    assert await files("b4").read("u1", "c1", REPORT) == b"v1"
    assert await files("b5").read("u1", "c1", REPORT) == b"v3"


async def test_a_fork_is_set_up_once(files):
    await files("b1", "a1").create("u1", "c1", REPORT, b"v1", agent_slug="omni")

    assert await files("b2").copy_branch("u1", "c1", "b1", ["a1"]) == 1
    assert await files("b2").copy_branch("u1", "c1", "b1", ["a1"]) == 0
    # A branch that already has its files is not forked into later.
    await files("b3").list_files("u1", "c1", "/")
    assert await files("b3").copy_branch("u1", "c1", "b1", ["a1"]) == 0


# ---------------------------------------------------------------------------
# The canvas documents follow the same cut
# ---------------------------------------------------------------------------
async def test_versions_comments_suggestions_and_seen_follow_the_cut(files, stores):
    seen_cls, suggestions_cls = _mod("seen").DocumentSeenStore, _mod("suggestions").DocumentSuggestionStore
    anchor = _mod("comments").CommentAnchor(quote="One")
    first = files("b1", "a1")
    await first.create("u1", "c1", REPORT, b"One", agent_slug="omni")
    await first.capture("u1", "c1", [REPORT], run_id="a1")
    await first.add_comment("u1", "c1", REPORT, version=1, body="on v1", anchor=anchor, parent_id=None)
    second = files("b1", "a2")
    await second.replace("u1", "c1", REPORT, b"One, twice", agent_slug="omni")
    await second.capture("u1", "c1", [REPORT], run_id="a2")
    await stores(suggestions_cls, "b1").put("u1", "c1", REPORT, base_version=2, content="One, three times")
    await stores(seen_cls, "b1").mark_seen("u1", "c1", {REPORT: 2})

    await files("b2").copy_branch("u1", "c1", "b1", ["a1"])

    assert [v.version for v in await files("b2").list_versions("u1", "c1", REPORT, limit=10)] == [1]
    assert [c.body for c in await files("b2").list_comments("u1", "c1", REPORT)] == ["on v1"]
    # The suggestions sat on v2, which stayed behind; the marker cannot point past v1.
    assert await stores(suggestions_cls, "b2").get("u1", "c1", REPORT) is None
    assert await stores(seen_cls, "b2").seen_versions("u1", "c1") == {REPORT: 1}
    # And the document is v1 again, ready for the new branch's own versions.
    latest = await files("b2").latest("u1", "c1", REPORT)
    assert (latest.version, latest.content) == (1, "One")


# ---------------------------------------------------------------------------
# Legacy rows and the boot migration
# ---------------------------------------------------------------------------
async def test_legacy_files_reach_every_branch_once(files):
    await files("").create("u1", "c1", REPORT, b"from before", agent_slug="omni")

    assert await files("b1").read("u1", "c1", REPORT) == b"from before"
    await files("b1", "a1").replace("u1", "c1", REPORT, b"b1's", agent_slug="omni")
    assert await files("b2").read("u1", "c1", REPORT) == b"from before"
    assert await files("").read("u1", "c1", REPORT) == b"from before"


OLD_SHAPE = (
    "CREATE TABLE conversation_file_blobs (user_id text NOT NULL, sha256 text NOT NULL, "
    "size_bytes bigint NOT NULL, cipher text NOT NULL, data bytea NOT NULL, "
    "created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (user_id, sha256))",
    "CREATE TABLE conversation_files (conversation_id text NOT NULL, path text COLLATE \"C\" NOT NULL, "
    "user_id text NOT NULL, sha256 text NOT NULL, size_bytes bigint NOT NULL, agent_slug text NOT NULL, "
    "source_run_id text, created_at timestamptz NOT NULL DEFAULT now(), "
    "updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (conversation_id, path))",
    "CREATE TABLE conversation_file_versions (id bigserial PRIMARY KEY, user_id text NOT NULL, "
    "conversation_id text NOT NULL, path text COLLATE \"C\" NOT NULL, version integer NOT NULL, "
    "sha256 text NOT NULL, size_bytes bigint NOT NULL, author text NOT NULL, base_version integer, "
    "source_run_id text, created_at timestamptz NOT NULL DEFAULT now(), "
    "CONSTRAINT conversation_file_versions_unique UNIQUE (conversation_id, path, version))",
    "CREATE TABLE conversation_file_seen (conversation_id text NOT NULL, path text COLLATE \"C\" NOT NULL, "
    "user_id text NOT NULL, agent_seen_version integer NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), "
    "PRIMARY KEY (conversation_id, path))",
    "CREATE TABLE conversation_file_comments (id uuid PRIMARY KEY, user_id text NOT NULL, "
    "conversation_id text NOT NULL, path text COLLATE \"C\" NOT NULL, version integer NOT NULL, parent_id uuid, "
    "cipher text NOT NULL, anchor bytea, body bytea NOT NULL, author text NOT NULL, status text, "
    "resolved_by text, resolution_note bytea, created_at timestamptz NOT NULL DEFAULT now(), "
    "updated_at timestamptz NOT NULL DEFAULT now(), "
    "CONSTRAINT conversation_file_comments_conversation_id_key UNIQUE (conversation_id, id), "
    "CONSTRAINT conversation_file_comments_version_fk FOREIGN KEY (conversation_id, path, version) "
    "REFERENCES conversation_file_versions (conversation_id, path, version) ON DELETE CASCADE)",
    "CREATE TABLE conversation_file_suggestions (conversation_id text NOT NULL, path text COLLATE \"C\" NOT NULL, "
    "user_id text NOT NULL, base_version integer NOT NULL, cipher text NOT NULL, content bytea NOT NULL, "
    "size_bytes bigint NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), "
    "updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (conversation_id, path), "
    "CONSTRAINT conversation_file_suggestions_version_fk FOREIGN KEY (conversation_id, path, base_version) "
    "REFERENCES conversation_file_versions (conversation_id, path, version) ON DELETE CASCADE)",
)


@pytest.mark.parametrize("had_suggestions", [True, False], ids=["with-suggestions", "before-suggestions"])
async def test_the_boot_moves_tables_of_the_old_shape_onto_branches(pg_pool, stores, had_suggestions):
    """Also from a database older than the suggestions table (Dennis on 2026-11-28):
    that table is new to it, and its key to the versions must not be created before
    the versions have the branch column, or the boot fails and the service never starts."""
    async with pg_pool.connection() as conn:
        for statement in OLD_SHAPE if had_suggestions else OLD_SHAPE[:-1]:
            await conn.execute(statement)
        await conn.execute("INSERT INTO conversation_file_blobs VALUES ('u1', 'sha', 3, 'none', 'old')")
        await conn.execute("INSERT INTO conversation_files (conversation_id, path, user_id, sha256, size_bytes, "
                           "agent_slug) VALUES ('c1', %s, 'u1', 'sha', 3, 'omni')", (REPORT,))
        await conn.execute("INSERT INTO conversation_file_versions (user_id, conversation_id, path, version, "
                           "sha256, size_bytes, author) VALUES ('u1', 'c1', %s, 1, 'sha', 3, 'agent')", (REPORT,))
    store = stores(_mod("versions").DocumentVersionStore, "b1")
    await store.setup()
    await store.setup()  # every boot runs it; the second changes nothing

    async with pg_pool.connection() as conn:
        cur = await conn.execute(
            "SELECT a.attname FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid "
            "AND a.attnum = ANY (c.conkey) WHERE c.conname = 'conversation_files_pkey'")
        assert {row["attname"] for row in await cur.fetchall()} == {"conversation_id", "branch_thread_id", "path"}
        cur = await conn.execute("SELECT branch_thread_id FROM conversation_files")
        assert [row["branch_thread_id"] for row in await cur.fetchall()] == [""]
        # Both version keys, on the branch column, whichever shape the boot started from.
        cur = await conn.execute(
            "SELECT c.conname, array_agg(a.attname::text ORDER BY a.attname) AS cols FROM pg_constraint c "
            "JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey) "
            "WHERE c.conname LIKE 'conversation_file_%version_fk' GROUP BY c.conname ORDER BY c.conname")
        keys = {row["conname"]: row["cols"] for row in await cur.fetchall()}
        assert set(keys) == {"conversation_file_comments_version_fk", "conversation_file_suggestions_version_fk"}
        assert all("branch_thread_id" in cols for cols in keys.values())
    assert await store.read("u1", "c1", REPORT) == b"old"
    assert (await store.latest("u1", "c1", REPORT)).version == 1
