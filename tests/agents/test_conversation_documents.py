"""Canvas document versions (plan 44, Phase 4.1) — the agents service's half.

Pinned, against a real Postgres (the version rules are SQL: the advisory lock,
the foreign key to the blobs, the GC probe):

* the first read of a document with no versions records its file as v1;
* a capture is idempotent — the same bytes add no version;
* a user save is 201 and also becomes the file the agent reads; a stale base
  is 409 with the latest text; two saves from one base: exactly one wins;
* a fork copies the versions; a reap and a purge delete them;
* the blob GC keeps a blob that only a version still names.

Without a server only the path validation and the internal-only guard run:
set ``CONVERSATION_FILES_TEST_DSN`` to a maintenance-database URL (e.g.
``postgresql://admin:admin@localhost:5432/postgres`` for the local compose
stack); a scratch database is created and dropped.
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
DOCS = "/users/u1/conversations/c1/documents"
BRIEF = "/conversation/output/brief.md"



@pytest.fixture(autouse=True)
def _on_one_branch(request):
    """Every file route names a conversation branch: these tests work on one."""
    if "client" in request.fixturenames:
        client = request.getfixturevalue("client")
        client.params = client.params.merge({"branch_thread_id": "b1"})

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
    database = f"conversation_documents_test_{uuid.uuid4().hex[:8]}"
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


@pytest_asyncio.fixture
async def docs(pg_pool, agents_service, monkeypatch):
    """A DocumentVersionStore on the scratch database, also behind the routes."""
    versions = importlib.import_module("harness.conversation_files.versions")
    cipher = importlib.import_module("harness.conversation_files.cipher").FileCipher(None)
    store = versions.DocumentVersionStore(pg_pool, cipher, branch="b1")
    await store.setup()
    await store.setup()  # idempotent: every boot runs it
    monkeypatch.setattr(importlib.import_module("utils.documents"), "_store", lambda *_: store)
    seen = importlib.import_module("harness.conversation_files.seen").DocumentSeenStore(pg_pool, cipher, branch="b1")
    monkeypatch.setattr(importlib.import_module("utils.documents"), "_seen_store", lambda *_: seen)
    return store


async def _count(pool, table: str) -> int:
    async with pool.connection() as conn:
        return (await (await conn.execute(f"SELECT count(*) AS n FROM {table}")).fetchone())["n"]


# ---------------------------------------------------------------------------
# No database needed
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("path", [
    "/conversation/output/brief.txt",
    "/conversation/input/brief.md",
    "/conversation/brief.md",
    "/conversation/output/../input/brief.md",
    "/conversation/output/.hidden.md",
    "conversation/output/brief.md",
    "/conversation/output/",
])
async def test_a_path_that_is_not_a_canvas_document_is_refused(agents_service, path):
    versions = importlib.import_module("harness.conversation_files.versions")
    with pytest.raises(versions.InvalidDocumentPath):
        versions.document_path(path)


async def test_a_path_is_canonicalised(agents_service):
    versions = importlib.import_module("harness.conversation_files.versions")
    assert versions.document_path("/conversation//output/notes/brief.md/") == "/conversation/output/notes/brief.md"


async def test_a_bad_path_is_a_422_before_any_query(client, internal_headers, agents_service, monkeypatch):
    def no_store(*_):
        raise AssertionError("the store must not be reached")

    monkeypatch.setattr(importlib.import_module("utils.documents"), "_store", no_store)

    latest = await client.get(f"{DOCS}/latest", params={"path": "/conversation/output/a.txt"},
                              headers=internal_headers)
    save = await client.post(f"{DOCS}/versions", headers=internal_headers,
                             json={"path": "/large_tool_results/x.md", "base_version": 1, "content": "x"})

    assert latest.status_code == 422 and save.status_code == 422


async def test_the_routes_are_internal_only(client):
    assert (await client.get(DOCS)).status_code == 403
    assert (await client.get(f"{DOCS}/latest", params={"path": BRIEF})).status_code == 403
    assert (await client.post(f"{DOCS}/versions", json={"path": BRIEF, "base_version": 1,
                                                        "content": "x"})).status_code == 403
    assert (await client.post(f"{DOCS}/capture", json={"paths": [BRIEF]})).status_code == 403


# ---------------------------------------------------------------------------
# Postgres
# ---------------------------------------------------------------------------
async def test_the_first_read_records_the_file_as_v1(docs, client, internal_headers):
    await docs.create("u1", "c1", BRIEF, b"# Brief", agent_slug="omni")

    response = await client.get(f"{DOCS}/latest", params={"path": BRIEF}, headers=internal_headers)

    assert response.status_code == 200
    body = response.json()
    assert {k: body[k] for k in ("path", "name", "version", "author", "base_version", "size_bytes", "content")} == {
        "path": BRIEF, "name": "brief.md", "version": 1, "author": "agent", "base_version": None,
        "size_bytes": 7, "content": "# Brief",
    }
    again = await client.get(f"{DOCS}/latest", params={"path": BRIEF}, headers=internal_headers)
    assert again.json()["version"] == 1  # read twice, recorded once


async def test_a_document_with_neither_versions_nor_a_file_is_a_404(docs, client, internal_headers):
    response = await client.get(f"{DOCS}/latest", params={"path": BRIEF}, headers=internal_headers)
    version = await client.get(f"{DOCS}/versions/1", params={"path": BRIEF}, headers=internal_headers)

    assert response.status_code == 404 and version.status_code == 404


async def test_a_capture_is_idempotent_and_records_only_changes(docs, client, internal_headers):
    await docs.create("u1", "c1", BRIEF, b"draft", agent_slug="omni")
    paths = [BRIEF, "/conversation/output/missing.md", "/conversation/output/chart.png", "nonsense"]

    first = await client.post(f"{DOCS}/capture", json={"paths": paths, "source_run_id": "run-1"},
                              headers=internal_headers)
    again = await client.post(f"{DOCS}/capture", json={"paths": paths}, headers=internal_headers)
    await docs.replace("u1", "c1", BRIEF, b"final", agent_slug="omni")
    changed = await client.post(f"{DOCS}/capture", json={"paths": [BRIEF]}, headers=internal_headers)

    assert first.json() == {"captured": [{"path": BRIEF, "version": 1, "created": True}]}
    assert again.json() == {"captured": [{"path": BRIEF, "version": 1, "created": False}]}
    assert changed.json() == {"captured": [{"path": BRIEF, "version": 2, "created": True}]}
    history = await client.get(f"{DOCS}/versions", params={"path": BRIEF}, headers=internal_headers)
    assert [(v["version"], v["author"], v["base_version"]) for v in history.json()["versions"]] == [
        (2, "agent", 1), (1, "agent", None),
    ]


async def test_a_user_save_is_a_new_version_and_the_agents_file(docs, client, internal_headers):
    await docs.create("u1", "c1", BRIEF, b"draft", agent_slug="omni")
    await docs.capture("u1", "c1", [BRIEF], run_id="run-1")

    response = await client.post(f"{DOCS}/versions", headers=internal_headers,
                                 json={"path": BRIEF, "base_version": 1, "content": "edited by me"})

    assert response.status_code == 201
    body = response.json()
    assert (body["path"], body["version"]) == (BRIEF, 2) and body["created_at"]
    assert await docs.read("u1", "c1", BRIEF) == b"edited by me"
    latest = (await client.get(f"{DOCS}/latest", params={"path": BRIEF}, headers=internal_headers)).json()
    assert (latest["version"], latest["author"], latest["base_version"], latest["content"]) == (
        2, "user", 1, "edited by me",
    )
    older = await client.get(f"{DOCS}/versions/1", params={"path": BRIEF}, headers=internal_headers)
    assert older.json()["content"] == "draft"
    # The agent's next capture of the same bytes adds nothing.
    assert (await docs.capture("u1", "c1", [BRIEF], run_id="run-2"))[0].created is False
    listing = (await client.get(DOCS, headers=internal_headers)).json()["documents"]
    assert [(d["path"], d["name"], d["version"], d["author"]) for d in listing] == [(BRIEF, "brief.md", 2, "user")]


async def test_a_stale_base_is_a_409_with_the_latest_text(docs, client, internal_headers):
    await docs.create("u1", "c1", BRIEF, b"v1", agent_slug="omni")
    await docs.capture("u1", "c1", [BRIEF], run_id=None)
    await docs.save_user_version("u1", "c1", BRIEF, base_version=1, content="v2 text")

    response = await client.post(f"{DOCS}/versions", headers=internal_headers,
                                 json={"path": BRIEF, "base_version": 1, "content": "my old edit"})

    assert response.status_code == 409
    assert response.json() == {"detail": {"code": "stale_base", "message": "The document has a newer version.", "current_version": 2,
                                          "current_content": "v2 text"}}
    assert await docs.read("u1", "c1", BRIEF) == b"v2 text"


async def test_content_over_the_cap_is_a_422(docs, client, internal_headers):
    await docs.create("u1", "c1", BRIEF, b"v1", agent_slug="omni")

    response = await client.post(f"{DOCS}/versions", headers=internal_headers,
                                 json={"path": BRIEF, "base_version": 1, "content": "é" * (600 * 1024)})

    assert response.status_code == 422  # 600 Ki characters, 1.2 MiB of UTF-8


async def test_two_saves_from_the_same_base_one_wins(docs):
    await docs.create("u1", "c1", BRIEF, b"v1", agent_slug="omni")
    await docs.capture("u1", "c1", [BRIEF], run_id=None)
    stale = importlib.import_module("harness.conversation_files.versions").StaleBase

    outcomes = await asyncio.gather(
        *(docs.save_user_version("u1", "c1", BRIEF, base_version=1, content=f"tab {i}") for i in range(2)),
        return_exceptions=True,
    )

    saved = [o for o in outcomes if not isinstance(o, BaseException)]
    refused = [o for o in outcomes if isinstance(o, stale)]
    assert len(saved) == 1 and len(refused) == 1
    assert saved[0].version == 2 and refused[0].current_version == 2
    assert refused[0].current_content == saved[0].content


async def test_a_fork_copies_the_versions_and_a_reap_drops_them(docs, pg_pool):
    await docs.create("u1", "c1", BRIEF, b"v1", agent_slug="omni")
    await docs.capture("u1", "c1", [BRIEF], run_id=None)
    await docs.save_user_version("u1", "c1", BRIEF, base_version=1, content="v2")

    assert await docs.copy_conversation("u1", "c1", "fork", source_branch="b1", messages=[]) == 1
    assert await docs.copy_conversation("u1", "c1", "fork", source_branch="b1", messages=[]) == 0  # a retried copy changes nothing
    fork = await docs.list_versions("u1", "fork", BRIEF, limit=10)
    assert [(v.version, v.author) for v in fork] == [(2, "user"), (1, "agent")]

    await docs.delete_conversation("u1", "c1")
    assert [v.version for v in await docs.list_versions("u1", "c1", BRIEF, limit=10)] == []
    assert (await docs.latest("u1", "fork", BRIEF)).content == "v2"  # the fork's blobs stayed
    await docs.delete_conversation("u1", "fork")
    assert await _count(pg_pool, "conversation_file_versions") == 0
    assert await _count(pg_pool, "conversation_file_blobs") == 0


async def test_a_purge_takes_every_version_of_that_user_only(docs):
    await docs.create("u1", "c1", BRIEF, b"mine", agent_slug="omni")
    await docs.create("u2", "c2", BRIEF, b"theirs", agent_slug="omni")
    await docs.capture("u1", "c1", [BRIEF], run_id=None)
    await docs.capture("u2", "c2", [BRIEF], run_id=None)

    counts = await docs.purge_user("u1")

    assert counts == {"conversation_files": 1, "conversation_file_writes": 1, "conversation_file_branches": 1,
                      "conversation_file_versions": 1, "conversation_file_seen": 0,
                      "conversation_file_comments": 0, "conversation_file_suggestions": 0,
                      "conversation_file_blobs": 1}
    assert (await docs.latest("u2", "c2", BRIEF)).content == "theirs"


async def test_the_gc_keeps_a_blob_only_a_version_names(docs, pg_pool):
    await docs.create("u1", "c1", BRIEF, b"first draft", agent_slug="omni")
    await docs.capture("u1", "c1", [BRIEF], run_id=None)

    # The agent overwrites the file: plan 36's GC would drop the old blob, but v1 names it.
    await docs.replace("u1", "c1", BRIEF, b"second draft", agent_slug="omni")

    assert await _count(pg_pool, "conversation_file_blobs") == 2
    assert (await docs.get_version("u1", "c1", BRIEF, 1)).content == "first draft"


async def test_another_users_conversation_id_reaches_nothing(docs):
    await docs.create("u1", "c1", BRIEF, b"mine", agent_slug="omni")
    await docs.capture("u1", "c1", [BRIEF], run_id=None)
    not_found = importlib.import_module("harness.conversation_files.versions").DocumentNotFound

    with pytest.raises(not_found):
        await docs.latest("u2", "c1", BRIEF)
    assert await docs.list_documents("u2", "c1", limit=10) == []
