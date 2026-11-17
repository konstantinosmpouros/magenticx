"""Citation markers never reach a file the agent writes (plan 42 follow-up).

``[src:ID]`` is a chat device: in a ``write_file`` / ``edit_file`` it would stay
raw text. Before the file is written, ``SourcesMiddleware`` turns each marker
into a markdown link to its page — resolved against the sources the agent was
shown, then the conversation's stored ones — and drops an id it cannot resolve.
"""
from __future__ import annotations

import asyncio
import importlib
from pathlib import Path
from typing import Any

import psycopg
import pytest
from langchain.agents.middleware.types import ModelResponse, ToolCallRequest
from langchain_core.messages import AIMessage, ToolMessage

FIXTURES = Path(__file__).parent / "fixtures" / "sources"
SEARCH = (FIXTURES / "tavily-search.txt").read_text(encoding="utf-8")


@pytest.fixture
def links(agents_service):
    return importlib.import_module("harness.sources.file_links")


@pytest.fixture
def mw(agents_service):
    return importlib.import_module("harness.middlewares.sources")


@pytest.fixture
def Source(agents_service):
    return importlib.import_module("harness.sources").Source


def _source(Source, id_: str, url: str) -> Any:
    return Source(id=id_, url=url, title="T", snippet="", tool="tavily-search")


# --------------------------------------------------------------------- the helper
def test_a_marker_becomes_a_link_to_its_page(links, Source):
    sources = {"3fa2c1": _source(Source, "3fa2c1", "https://www.imf.org/en/greece")}
    text = "Debt reached 180% of GDP [src:3fa2c1]."
    assert links.markers_to_links(text, sources) == "Debt reached 180% of GDP ([imf.org](https://www.imf.org/en/greece))."


def test_several_ids_become_several_links_and_an_unknown_one_is_dropped(links, Source):
    sources = {
        "3fa2c1": _source(Source, "3fa2c1", "https://a.example/x"),
        "9b02e4": _source(Source, "9b02e4", "https://b.example/y"),
    }
    text = "Both agree [src:3fa2c1, 9b02e4, ffffff]. Nobody said [src:aaaaaa]."
    assert links.markers_to_links(text, sources) == (
        "Both agree ([a.example](https://a.example/x); [b.example](https://b.example/y)). Nobody said."
    )


def test_markers_in_code_are_left_as_written(links, Source):
    sources = {"3fa2c1": _source(Source, "3fa2c1", "https://a.example/")}
    text = "Use `[src:3fa2c1]` in chat.\n\n```md\nfact [src:3fa2c1]\n```\nfact [src:3fa2c1]"
    out = links.markers_to_links(text, sources)
    assert "`[src:3fa2c1]`" in out and "```md\nfact [src:3fa2c1]\n```" in out
    assert out.endswith("fact ([a.example](https://a.example/))")


def test_a_marker_beside_a_link_to_the_same_page_is_dropped(links, Source):
    sources = {"53b31d": _source(Source, "53b31d", "https://arxiv.org/abs/2507.21046v4")}
    text = "A map of the field. [arXiv:2507.21046] (https://arxiv.org/abs/2507.21046v4) [src:53b31d]\n\nNext [src:53b31d]."
    assert links.markers_to_links(text, sources) == (
        "A map of the field. [arXiv:2507.21046] (https://arxiv.org/abs/2507.21046v4)\n\n"
        "Next ([arxiv.org](https://arxiv.org/abs/2507.21046v4))."
    )


def test_text_without_markers_is_unchanged(links):
    assert not links.has_markers("plain [link](https://x.example) text")
    assert links.markers_to_links("plain text", {}) == "plain text"


# ------------------------------------------------------------------ the middleware
class _Store:
    def __init__(self, stored: list[Any] | None = None, fail: BaseException | None = None):
        self.stored = stored or []
        self.fail = fail
        self.listed = 0

    async def upsert_many(self, user_id, conversation_id, sources):
        return len(sources)

    async def list_sources(self, user_id, conversation_id, limit=500):
        self.listed += 1
        if self.fail is not None:
            raise self.fail
        return list(self.stored)


def _request(name: str, args: dict[str, Any], call_id: str = "w1") -> ToolCallRequest:
    return ToolCallRequest(tool_call={"id": call_id, "name": name, "args": args}, tool=None, state={}, runtime=None)


def _search(middleware) -> list[dict[str, Any]]:
    """Run one search through the middleware; the stamped sources."""
    async def handler(request):
        return ToolMessage(content=SEARCH, tool_call_id="s1", name="tavily-search")

    result = asyncio.run(middleware.awrap_tool_call(_request("tavily-search", {"query": "q"}, "s1"), handler))
    return result.response_metadata[importlib.import_module("harness.middlewares.sources").SOURCES_KEY]


def _write(middleware, name: str, args: dict[str, Any]) -> dict[str, Any]:
    """Run a file tool through the middleware; the args the tool really got."""
    seen: dict[str, Any] = {}

    async def handler(request):
        seen.update(request.tool_call["args"])
        return ToolMessage(content="ok", tool_call_id="w1", name=name)

    asyncio.run(middleware.awrap_tool_call(_request(name, args), handler))
    return seen


def test_a_file_cites_the_pages_the_agent_found(mw):
    middleware = mw.SourcesMiddleware(user_id="u1", conversation_id="c1", store=_Store())
    first = _search(middleware)[0]
    got = _write(middleware, "write_file", {"file_path": "/brief.md", "content": f"A fact [src:{first['id']}]."})
    assert "[src:" not in got["content"]
    assert f"]({first['url']}))." in got["content"]
    assert got["file_path"] == "/brief.md"


def test_an_edit_s_new_text_is_linked_too(mw):
    middleware = mw.SourcesMiddleware(store=_Store())
    first = _search(middleware)[0]
    got = _write(middleware, "edit_file", {"file_path": "/a.md", "old_string": "x [src:aaaaaa]",
                                           "new_string": f"y [src:{first['id']}]"})
    assert got["old_string"] == "x [src:aaaaaa]"  # must still match the file
    assert got["new_string"] == f"y ([{first['url'].split('/')[2].removeprefix('www.')}]({first['url']}))"


def test_a_source_another_agent_found_resolves_from_the_store(mw, Source):
    stored = _source(Source, "abc123", "https://found.example/by-researcher")
    store = _Store(stored=[stored])
    middleware = mw.SourcesMiddleware(user_id="u1", conversation_id="c1", store=store)
    got = _write(middleware, "write_file", {"file_path": "/b.md", "content": "Fact [src:abc123]."})
    assert got["content"] == "Fact ([found.example](https://found.example/by-researcher))."
    assert store.listed == 1


def test_the_store_is_not_asked_when_every_id_is_known(mw):
    store = _Store()
    middleware = mw.SourcesMiddleware(user_id="u1", conversation_id="c1", store=store)
    first = _search(middleware)[0]
    _write(middleware, "write_file", {"file_path": "/c.md", "content": f"F [src:{first['id']}]."})
    assert store.listed == 0


def test_a_store_failure_still_writes_the_file_without_the_markers(mw):
    store = _Store(fail=psycopg.OperationalError("down"))
    middleware = mw.SourcesMiddleware(user_id="u1", conversation_id="c1", store=store)
    got = _write(middleware, "write_file", {"file_path": "/d.md", "content": "Fact [src:abc123]."})
    assert got["content"] == "Fact."


def test_other_tools_and_marker_free_files_pass_through_untouched(mw):
    middleware = mw.SourcesMiddleware(store=_Store())
    request = _request("write_file", {"file_path": "/e.md", "content": "no markers"})
    passed: list[Any] = []

    async def handler(r):
        passed.append(r)
        return ToolMessage(content="ok", tool_call_id="w1")

    asyncio.run(middleware.awrap_tool_call(request, handler))
    assert passed == [request]
    got = _write(middleware, "execute", {"command": "echo [src:abc123]"})
    assert got["command"] == "echo [src:abc123]"


def _model_turn(content: str, name: str = "write_file") -> AIMessage:
    return AIMessage(content="", tool_calls=[
        {"id": "w1", "name": name, "args": {"file_path": "/brief.md", "content": content}},
        {"id": "t2", "name": "tavily-search", "args": {"query": "[src:abc123]"}},
    ])


def test_the_model_s_own_call_is_linked_before_any_approval_sees_it(mw, Source):
    """HITL pauses in ``after_model``, before any tool runs: the rewrite must
    already be on the model's message, so the approval card shows links."""
    stored = _source(Source, "abc123", "https://found.example/page")
    middleware = mw.SourcesMiddleware(user_id="u1", conversation_id="c1", store=_Store(stored=[stored]))

    async def model(request):
        return ModelResponse(result=[_model_turn("Fact [src:abc123].")])

    response = asyncio.run(middleware.awrap_model_call(None, model))
    [message] = response.result
    write, search = message.tool_calls
    assert write["args"]["content"] == "Fact ([found.example](https://found.example/page))."
    assert write["id"] == "w1" and write["args"]["file_path"] == "/brief.md"
    assert search["args"] == {"query": "[src:abc123]"}  # only file tools change


def test_a_model_turn_without_file_markers_is_returned_as_is(mw):
    store = _Store()
    middleware = mw.SourcesMiddleware(user_id="u1", conversation_id="c1", store=store)
    response = ModelResponse(result=[_model_turn("No markers here.")])

    async def model(request):
        return response

    assert asyncio.run(middleware.awrap_model_call(None, model)) is response
    assert store.listed == 0


def test_the_sync_model_path_links_what_the_agent_was_shown(mw):
    middleware = mw.SourcesMiddleware(store=_Store())
    first = _search(middleware)[0]
    message = middleware.wrap_model_call(None, lambda request: _model_turn(f"F [src:{first['id']}]."))
    assert "[src:" not in message.tool_calls[0]["args"]["content"]
    assert first["url"] in message.tool_calls[0]["args"]["content"]


def test_the_sync_path_links_what_the_agent_was_shown(mw):
    middleware = mw.SourcesMiddleware(store=_Store())
    first = middleware.wrap_tool_call(
        _request("tavily-search", {"query": "q"}, "s1"),
        lambda r: ToolMessage(content=SEARCH, tool_call_id="s1"),
    ).response_metadata[mw.SOURCES_KEY][0]
    got: dict[str, Any] = {}
    middleware.wrap_tool_call(
        _request("write_file", {"file_path": "/f.md", "content": f"F [src:{first['id']}] and [src:abc123]."}),
        lambda r: got.update(r.tool_call["args"]) or ToolMessage(content="ok", tool_call_id="w1"),
    )
    assert got["content"] == f"F ([{first['url'].split('/')[2].removeprefix('www.')}]({first['url']})) and."


def test_the_prompt_keeps_markers_in_the_chat_and_links_in_files(agents_service):
    """After a file is written with links, the model must not copy that style
    into its chat reply (it would lose the citation pills and the Sources)."""
    pe = importlib.import_module("harness.prompt_engineering")
    text = pe.compose_system_prompt("", pe.PromptContext(has_source_tools=True))
    assert "Inside a file you write, link the page" in text
    assert "Your chat reply keeps the markers" in text
