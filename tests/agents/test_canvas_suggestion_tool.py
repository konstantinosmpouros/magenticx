"""``review_suggestions`` (plan 44, Phase 4.6) — the agent accepts or rejects the user's pending suggestions.

Pinned:

* the tool is auto-attached under the comment tools' gate (a user's
  conversation with a canvas document, not a background task) and only with
  the run's conversation files; it is a Canvas builtin, never HITL-gated, and
  spends nothing of the comment-write budget;
* its scope is the run's conversation files (from the run config) — the
  model's arguments are only ``path`` and ``decision``;
* a bad path or decision is refused with a ``Could not …:`` string before
  any store is reached;
* the prompt's suggestions block (with the canvas tools only) and the note's
  lead say: only when the user explicitly asks, never on the agent's own
  initiative, then one line;
* against a real Postgres: ``reject`` deletes the set and writes nothing (no
  version, file unchanged); ``accept`` writes the proposed text into the
  document's file as the run's own edit and deletes the set — and the
  bridge's run-end capture then records it as the agent's version and moves
  the seen marker; a set made on an older version, or a file the agent
  changed this turn, is refused with nothing written; no set is an error;
  another conversation's set is never touched; a set the user saved again
  meanwhile is not deleted by an accept of the old one.

The Postgres half needs ``CONVERSATION_FILES_TEST_DSN`` (see
``test_document_suggestions.py``); without it those tests skip.
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
BRIEF = "/conversation/output/brief.md"
BASE = "# Brief\n\nThe plan is short.\nKeep it.\n"
PROPOSED = "# Brief\n\nThe plan is very short.\nKeep it.\nA new line.\n"
NAME = "review_suggestions"
NONE_PENDING = "There are no pending suggestions on that document."


@pytest.fixture
def registry(agents_service):
    return importlib.import_module("harness.tools.registry")


@pytest.fixture
def tool_mod(agents_service):
    return importlib.import_module("harness.tools.canvas_suggestions.tool")


def _files(agents_service, store=None, *, conversation_id="c1", run_id="run-1"):
    files_mod = importlib.import_module("harness.conversation_files.files")
    return files_mod.ConversationFiles(user_id="u1", conversation_id=conversation_id, agent_slug="omni",
                                       store=store, run_id=run_id)


# ---------------------------------------------------------------------------
# Who gets the tool (no database)
# ---------------------------------------------------------------------------
def _ctx(agents_service, registry, **overrides):
    budget = importlib.import_module("harness.tools.canvas_comments").CommentWriteBudget()
    fields = {"user_id": "u1", "agent_slug": "omni", "conversation_id": "c1", "use_memory": False,
              "has_canvas_documents": True, "comment_writes": budget,
              "files": _files(agents_service)} | overrides
    return registry.NativeToolContext(**fields)


async def test_a_conversation_with_a_canvas_document_gets_it_after_the_comment_tools(agents_service, registry):
    names = [tool.name for tool in registry.build_auto_attach_tools(_ctx(agents_service, registry))]
    canvas = [n for n in names if n in ("list_comments", "reply_to_comment", "add_comment", NAME)]
    assert canvas == ["list_comments", "reply_to_comment", "add_comment", NAME]


@pytest.mark.parametrize("overrides", [
    {"has_canvas_documents": False},
    {"conversation_id": None},
    {"comment_writes": None},
    {"async_task_id": "task-1"},
    {"files": None},
])
async def test_without_the_gate_or_the_files_there_is_none(agents_service, registry, overrides):
    ctx = _ctx(agents_service, registry, **overrides)
    assert NAME not in [tool.name for tool in registry.build_auto_attach_tools(ctx)]
    assert registry.NATIVE_TOOLS[NAME].builder(ctx) is None


async def test_it_is_a_canvas_builtin_and_not_gated(agents_service):
    builtins_mod = importlib.import_module("harness.tools.builtins")
    entry = builtins_mod.BUILTIN_BY_NAME[NAME]
    assert (entry.group, entry.hitl_default, entry.locked) == ("Canvas", False, False)
    assert NAME not in builtins_mod.builtin_hitl_defaults()
    assert importlib.import_module("harness.tools.registry").NATIVE_TOOLS[NAME].hitl_default is False


async def test_its_scope_is_the_runs_files_never_an_argument(agents_service, tool_mod):
    tool = tool_mod.build_review_suggestions_tool(files=_files(agents_service))
    assert set(tool.args) == {"path", "decision"}
    assert tool.args["decision"].get("enum") == ["accept", "reject"]
    assert "ONLY when the user explicitly asks" in tool.description


async def test_it_spends_no_comment_write(agents_service, registry, tool_mod, monkeypatch):
    class _Empty:
        async def delete(self, *_args, **_kwargs):
            return False

    monkeypatch.setattr(tool_mod, "_store", lambda: _Empty())
    ctx = _ctx(agents_service, registry)
    tool = registry.NATIVE_TOOLS[NAME].builder(ctx)

    await tool.ainvoke({"path": BRIEF, "decision": "reject"})

    assert [ctx.comment_writes.take() for _ in range(10)] == [True] * 10


async def test_bad_arguments_are_refused_without_a_store(agents_service, tool_mod, monkeypatch):
    def no_store():
        raise AssertionError("the store must not be reached")

    monkeypatch.setattr(tool_mod, "_store", no_store)
    tool = tool_mod.build_review_suggestions_tool(files=_files(agents_service))

    assert await tool.coroutine(path="/conversation/input/a.md", decision="accept") == (
        "Could not apply the suggestions: a canvas document is a .md file under /conversation/output/.")
    assert await tool.coroutine(path="/conversation/output/../x.md", decision="reject") == (
        "Could not reject the suggestions: a canvas document is a .md file under /conversation/output/.")
    assert await tool.coroutine(path=BRIEF, decision="merge") == (
        "Could not review the suggestions: 'decision' is 'accept' or 'reject'.")


async def test_the_prompt_says_only_when_the_user_asks(agents_service):
    context = importlib.import_module("harness.prompt_engineering.context")
    documents = importlib.import_module("harness.prompt_engineering.prompts.documents_prompt")
    without = documents.documents_prompt(context.PromptContext(has_conversation=True))
    with_tools = documents.documents_prompt(context.PromptContext(has_conversation=True, has_canvas_comments=True))

    assert NAME not in without
    assert "### The user's suggestions on canvas documents" in with_tools
    for phrase in ("Use `review_suggestions`\nONLY when the user explicitly asks you to accept / apply or reject / "
                   "remove\ntheir suggestions — never on your own initiative",
                   "ask the user to review\nthem in the canvas; do not merge them yourself",
                   "After it, say in one line\nwhat happened."):
        assert phrase in with_tools


async def test_the_notes_lead_says_only_when_the_user_asks(agents_service):
    notes = importlib.import_module("harness.canvas.notes")
    suggestions = importlib.import_module("harness.conversation_files.suggestions")
    pending = suggestions.PendingSuggestions(documents=[suggestions.PendingSuggestion(
        path=BRIEF, base_version=1, latest_version=1, base_text=BASE, proposed_text=PROPOSED)], total=1)

    note = notes.render_edit_notes([], [], pending)

    assert "Call review_suggestions (accept or reject) ONLY when the user explicitly asks" in note
    assert "never on your own initiative — then say in one line what happened." in note


# ---------------------------------------------------------------------------
# Postgres
# ---------------------------------------------------------------------------
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
    database = f"canvas_suggestion_tool_test_{uuid.uuid4().hex[:8]}"
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
async def store(pg_pool, tool_mod, monkeypatch):
    """A suggestion store on the scratch database, behind the tool; brief.md has v1 with a pending set on it."""
    suggestions = importlib.import_module("harness.conversation_files.suggestions").DocumentSuggestionStore(
        pg_pool, importlib.import_module("harness.conversation_files.cipher").FileCipher(None))
    await suggestions.setup()
    monkeypatch.setattr(tool_mod, "_store", lambda: suggestions)
    await suggestions.create("u1", "c1", BRIEF, BASE.encode(), agent_slug="omni")
    await suggestions.capture("u1", "c1", [BRIEF], run_id=None)
    await suggestions.put("u1", "c1", BRIEF, base_version=1, content=PROPOSED)
    return suggestions


def _tool(agents_service, tool_mod, store, conversation_id="c1"):
    return tool_mod.build_review_suggestions_tool(files=_files(agents_service, store, conversation_id=conversation_id))


async def _count(pool, table: str) -> int:
    async with pool.connection() as conn:
        return (await (await conn.execute(f"SELECT count(*) AS n FROM {table}")).fetchone())["n"]


async def test_reject_deletes_the_set_and_writes_nothing(agents_service, tool_mod, store, pg_pool):
    result = await _tool(agents_service, tool_mod, store).ainvoke({"path": BRIEF, "decision": "reject"})

    assert result == "Rejected the user's suggestions on brief.md; the document is unchanged."
    assert await store.get("u1", "c1", BRIEF) is None
    assert await store.read("u1", "c1", BRIEF) == BASE.encode()
    assert await _count(pg_pool, "conversation_file_versions") == 1
    # The run-end capture finds nothing new either.
    assert [r.created for r in await store.capture("u1", "c1", [BRIEF], run_id="run-1")] == [False]


async def test_accept_writes_the_file_as_the_agents_edit_and_deletes_the_set(agents_service, tool_mod, store,
                                                                            pg_pool, monkeypatch):
    result = await _tool(agents_service, tool_mod, store).ainvoke({"path": BRIEF, "decision": "accept"})

    assert result == "Applied the user's suggestions to brief.md."
    assert await store.get("u1", "c1", BRIEF) is None
    assert await store.read("u1", "c1", BRIEF) == PROPOSED.encode()
    [entry] = await store.list_files("u1", "c1", "/conversation/output")
    assert entry.agent_slug == "omni"  # written as the run's own edit, not as the user's save
    # No version yet: the bridge's run-end capture records it, as after any agent edit.
    assert await _count(pg_pool, "conversation_file_versions") == 1

    documents = importlib.import_module("utils.documents")
    seen = importlib.import_module("harness.conversation_files.seen").DocumentSeenStore(pg_pool, store._cipher)
    monkeypatch.setattr(documents, "_seen_store", lambda: seen)
    captured = await documents.capture_documents("u1", "c1", [], source_run_id="run-1")

    assert [(c.path, c.version, c.created) for c in captured.captured] == [(BRIEF, 2, True)]
    latest = await store.latest("u1", "c1", BRIEF)
    assert (latest.version, latest.author, latest.base_version, latest.content) == (2, "agent", 1, PROPOSED)
    assert await seen.seen_versions("u1", "c1") == {BRIEF: 2}


async def test_a_set_on_an_older_version_is_refused_and_nothing_written(agents_service, tool_mod, store):
    # The agent edited the document after the suggestions (now v2).
    await store.replace("u1", "c1", BRIEF, (BASE + "agent line\n").encode(), agent_slug="omni")
    await store.capture("u1", "c1", [BRIEF], run_id="run-0")

    result = await _tool(agents_service, tool_mod, store).ainvoke({"path": BRIEF, "decision": "accept"})

    assert result == ("Could not apply the suggestions: they were made on v1 and the document is now at v2. "
                      "Do not merge them yourself: ask the user to review them in the canvas.")
    assert await store.read("u1", "c1", BRIEF) == (BASE + "agent line\n").encode()
    assert (await store.get("u1", "c1", BRIEF)).content == PROPOSED


async def test_a_file_the_agent_changed_this_turn_is_not_overwritten(agents_service, tool_mod, store, pg_pool):
    # Edited this run, not yet captured: the latest version is still the base.
    await store.replace("u1", "c1", BRIEF, (BASE + "draft\n").encode(), agent_slug="omni")

    result = await _tool(agents_service, tool_mod, store).ainvoke({"path": BRIEF, "decision": "accept"})

    assert result.startswith("Could not apply the suggestions: the document changed after they were made")
    assert result.endswith("ask the user to review them in the canvas.")
    assert await store.read("u1", "c1", BRIEF) == (BASE + "draft\n").encode()
    assert await store.get("u1", "c1", BRIEF) is not None
    assert await _count(pg_pool, "conversation_file_versions") == 1


async def test_no_pending_set_is_an_error(agents_service, tool_mod, store):
    await store.delete("u1", "c1", BRIEF)
    tool = _tool(agents_service, tool_mod, store)

    assert await tool.ainvoke({"path": BRIEF, "decision": "accept"}) == f"Could not apply the suggestions: {NONE_PENDING}"
    assert await tool.ainvoke({"path": BRIEF, "decision": "reject"}) == (
        f"Could not reject the suggestions: {NONE_PENDING}")
    assert await tool.ainvoke({"path": "/conversation/output/other.md", "decision": "accept"}) == (
        f"Could not apply the suggestions: {NONE_PENDING}")
    assert await store.read("u1", "c1", BRIEF) == BASE.encode()


async def test_another_conversations_set_is_never_touched(agents_service, tool_mod, store):
    other = _tool(agents_service, tool_mod, store, conversation_id="c2")

    assert NONE_PENDING in await other.ainvoke({"path": BRIEF, "decision": "reject"})
    assert NONE_PENDING in await other.ainvoke({"path": BRIEF, "decision": "accept"})
    assert (await store.get("u1", "c1", BRIEF)).content == PROPOSED
    assert await store.read("u1", "c1", BRIEF) == BASE.encode()


async def test_an_accept_never_deletes_a_set_saved_again_meanwhile(agents_service, store):
    applied = await store.get("u1", "c1", BRIEF)
    await store.put("u1", "c1", BRIEF, base_version=1, content=PROPOSED + "more\n")  # the user saves again

    assert await store.delete("u1", "c1", BRIEF, saved_at=applied.updated_at) is False
    assert (await store.get("u1", "c1", BRIEF)).content == PROPOSED + "more\n"
