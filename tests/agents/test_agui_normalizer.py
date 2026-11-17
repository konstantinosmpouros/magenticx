from __future__ import annotations

import json

import pytest
from langchain_core.messages import AIMessage, AIMessageChunk, HumanMessage, ToolMessage


def _norm(agents_service, thread_id="t-1"):
    return agents_service.normalizer.AGUIStreamNormalizer(thread_id=thread_id)


@pytest.fixture(autouse=True)
def _clear_run_memory(agents_service):
    # What a run announced persists per thread_id across normalizer instances
    # (so a HITL resume does not repeat it). Tests share thread_id="t-1", so
    # clear the module-global store around each test to keep them isolated.
    agents_service.normalizer._RUNS.clear()
    yield
    agents_service.normalizer._RUNS.clear()


def _decode(frame):
    """An AG-UI event: as is when already a dict (the normalizer's internals),
    else the JSON data payload of its SSE frame."""
    if isinstance(frame, dict):
        return frame
    if isinstance(frame, (bytes, bytearray)):
        text = frame.decode("utf-8")
    else:
        text = str(frame)
    for line in text.splitlines():
        if line.startswith("data:"):
            return json.loads(line[len("data:"):].lstrip())
    raise AssertionError(f"no data line in frame: {text!r}")


def _payloads(frames):
    return [_decode(f) for f in frames]


def _types(frames):
    return [p.get("type") for p in _payloads(frames)]


def _names(frames):
    """For CUSTOM events, return the 'name' field; else the 'type'."""
    out = []
    for p in _payloads(frames):
        if p.get("type") == "CUSTOM":
            out.append(p.get("name"))
        else:
            out.append(p.get("type"))
    return out


def _custom_value(frame):
    p = _decode(frame)
    assert p.get("type") == "CUSTOM"
    return p["name"], p["value"]


# ----------------------------------------------------------------------------
# envelope unwrapping
# ----------------------------------------------------------------------------
def test_unwrap_two_tuple_messages(agents_service):
    norm = _norm(agents_service)
    mode, payload, meta = norm._unwrap(("messages", AIMessageChunk(content="hi")))
    assert mode == "messages"
    assert isinstance(payload, AIMessageChunk)
    assert meta is None


def test_unwrap_legacy_message_meta_tuple(agents_service):
    norm = _norm(agents_service)
    msg = AIMessageChunk(content="hi")
    chunk = ("messages", (msg, {"k": "v"}))
    mode, payload, meta = norm._unwrap(chunk)
    assert mode == "messages"
    assert payload is msg
    assert meta == {"k": "v"}


def test_unwrap_legacy_message_meta_tuple_non_dict_meta(agents_service):
    norm = _norm(agents_service)
    msg = AIMessageChunk(content="hi")
    chunk = ("messages", (msg, "not-a-dict"))
    mode, payload, meta = norm._unwrap(chunk)
    assert mode == "messages"
    assert payload is msg
    assert meta is None


def test_unwrap_dict_chunk_is_updates(agents_service):
    norm = _norm(agents_service)
    mode, payload, meta = norm._unwrap({"some_node": {}})
    assert mode == "updates"
    assert payload == {"some_node": {}}


def test_unwrap_unknown_chunk(agents_service):
    norm = _norm(agents_service)
    mode, payload, meta = norm._unwrap("just a string")
    assert mode is None
    assert payload == "just a string"


def test_unwrap_metadata_after_payload(agents_service):
    norm = _norm(agents_service)
    chunk = ("updates", {"n": {}}, {"meta": 1})
    mode, payload, meta = norm._unwrap(chunk)
    assert mode == "updates"
    assert meta == {"meta": 1}


def test_handle_chunk_unknown_mode_returns_empty(agents_service):
    norm = _norm(agents_service)
    assert norm.handle_chunk("not a recognized chunk") == []


# ----------------------------------------------------------------------------
# messages mode — AI text deltas
# ----------------------------------------------------------------------------
def test_ai_message_chunk_first_delta_emits_start_then_chunk(agents_service):
    norm = _norm(agents_service)
    out = norm.handle_chunk(("messages", AIMessageChunk(content="Hello")))
    types = _types(out)
    assert types == ["TEXT_MESSAGE_START", "TEXT_MESSAGE_CHUNK"]
    # message_id is the thread_id
    start = _decode(out[0])
    assert start["messageId"] == "t-1"


def test_ai_message_chunk_second_delta_only_chunk(agents_service):
    norm = _norm(agents_service)
    norm.handle_chunk(("messages", AIMessageChunk(content="Hello")))
    out = norm.handle_chunk(("messages", AIMessageChunk(content=" world")))
    assert _types(out) == ["TEXT_MESSAGE_CHUNK"]
    chunk = _decode(out[0])
    assert chunk["delta"] == " world"


def test_ai_message_empty_delta_no_events(agents_service):
    norm = _norm(agents_service)
    out = norm.handle_chunk(("messages", AIMessageChunk(content="")))
    assert out == []


def test_ai_message_list_content_extracts_text(agents_service):
    norm = _norm(agents_service)
    content = [
        {"type": "text", "text": "foo"},
        {"type": "text", "text": "bar"},
        {"type": "image", "url": "ignored"},
        "baz",  # a bare string in a content list is text (Gemini)
    ]
    out = norm.handle_chunk(("messages", AIMessageChunk(content=content)))
    types = _types(out)
    assert types[-1] == "TEXT_MESSAGE_CHUNK"
    assert _decode(out[-1])["delta"] == "foobarbaz"


def test_messages_other_kind_ignored(agents_service):
    norm = _norm(agents_service)
    out = norm.handle_chunk(("messages", HumanMessage(content="user text")))
    assert out == []


# ----------------------------------------------------------------------------
# messages mode — summarization suppression
#
# deepagents/langchain compresses history via an internal LLM call whose tokens
# stream on the messages channel tagged metadata.lc_source=="summarization". It
# must never render as the assistant's reply (the "SESSION INTENT/SUMMARY/..."
# leak). The normalizer drops any messages-mode chunk carrying that marker.
# ----------------------------------------------------------------------------
def test_summarization_ai_chunk_suppressed(agents_service):
    # The summary's text never surfaces; only the fact that a compaction
    # started does (plan 34), once.
    norm = _norm(agents_service)
    chunk = (
        "messages",
        AIMessageChunk(content="## SESSION INTENT\nSummarize the PDF."),
        {"langgraph_node": "model", "lc_source": "summarization"},
    )
    first = norm.handle_chunk(chunk)
    assert _names(first) == ["CONTEXT_COMPACTION"]
    assert _custom_value(first[0])[1] == {"phase": "started", "trigger": "auto"}
    assert norm.handle_chunk(chunk) == []


def test_summarization_then_real_answer_only_emits_answer(agents_service):
    norm = _norm(agents_service)
    # internal summarization stream — suppressed
    norm.handle_chunk(
        ("messages", AIMessageChunk(content="## SUMMARY\nstuff"), {"lc_source": "summarization"})
    )
    # the real reply that follows — must still render, starting cleanly
    out = norm.handle_chunk(
        ("messages", AIMessageChunk(content="Here is the real answer."), {"langgraph_node": "model"})
    )
    assert _types(out) == ["TEXT_MESSAGE_START", "TEXT_MESSAGE_CHUNK"]
    assert _decode(out[-1])["delta"] == "Here is the real answer."


# ----------------------------------------------------------------------------
# messages mode — ToolMessage results
# ----------------------------------------------------------------------------
def test_tool_message_result_only_if_pending(agents_service):
    norm = _norm(agents_service)
    # tool_call_id not pending => nothing emitted
    tm = ToolMessage(content="result", tool_call_id="tc-1")
    out = norm.handle_chunk(("messages", tm))
    assert out == []


def test_tool_message_result_emits_after_started(agents_service):
    norm = _norm(agents_service)
    # Start a tool through updates first
    ai = AIMessage(
        content="",
        tool_calls=[{"id": "tc-1", "name": "search", "args": {"q": "x"}}],
    )
    start_out = norm.handle_chunk(("updates", {"agent": {"messages": [ai]}}))
    assert _names(start_out) == ["TOOL_CALL_START", "TOOL_CALL_ARGS"]

    tm = ToolMessage(content="the answer", tool_call_id="tc-1")
    out = norm.handle_chunk(("messages", tm))
    assert _types(out) == ["TOOL_CALL_RESULT", "TOOL_CALL_END"]
    res = _decode(out[0])
    assert res["content"] == "the answer"


def test_tool_message_result_deduped_after_finished(agents_service):
    norm = _norm(agents_service)
    ai = AIMessage(content="", tool_calls=[{"id": "tc-1", "name": "search", "args": {}}])
    norm.handle_chunk(("updates", {"agent": {"messages": [ai]}}))
    tm = ToolMessage(content="x", tool_call_id="tc-1")
    norm.handle_chunk(("messages", tm))
    # second time => already finished => no events
    out = norm.handle_chunk(("messages", tm))
    assert out == []


def test_tool_message_no_tool_call_id_ignored(agents_service):
    norm = _norm(agents_service)
    tm = ToolMessage(content="x", tool_call_id="")
    out = norm.handle_chunk(("messages", tm))
    assert out == []


def test_tool_message_ignored_id_discarded(agents_service):
    norm = _norm(agents_service)
    # write_todos marks the id ignored
    ai = AIMessage(
        content="",
        tool_calls=[{"id": "wt-1", "name": "write_todos", "args": {"todos": [{"content": "a", "status": "pending"}]}}],
    )
    norm.handle_chunk(("updates", {"agent": {"messages": [ai]}}))
    assert "wt-1" in norm._silent_tools
    tm = ToolMessage(content="ignored", tool_call_id="wt-1")
    out = norm.handle_chunk(("messages", tm))
    assert out == []
    # discarded from the ignored set
    assert "wt-1" not in norm._silent_tools


# ----------------------------------------------------------------------------
# updates mode — tool calls
# ----------------------------------------------------------------------------
def test_updates_non_dict_payload_returns_empty(agents_service):
    norm = _norm(agents_service)
    out = norm._on_updates(["not", "a", "dict"], None)
    assert out == []


def test_updates_node_value_none_or_non_dict_skipped(agents_service):
    norm = _norm(agents_service)
    out = norm.handle_chunk(("updates", {"node_a": None, "node_b": "string"}))
    assert out == []


def test_updates_normal_tool_emits_start_args(agents_service):
    norm = _norm(agents_service)
    ai = AIMessage(content="", tool_calls=[{"id": "tc-9", "name": "calc", "args": {"a": 1}}])
    out = norm.handle_chunk(("updates", {"agent": {"messages": [ai]}}))
    assert _names(out) == ["TOOL_CALL_START", "TOOL_CALL_ARGS"]
    args = _decode(out[1])
    assert json.loads(args["delta"]) == {"name": "calc", "args": {"a": 1}}
    assert "tc-9" in norm._open_tools
    assert "tc-9" in norm._started_tools


def test_updates_normal_tool_deduped_when_already_started(agents_service):
    norm = _norm(agents_service)
    ai = AIMessage(content="", tool_calls=[{"id": "tc-9", "name": "calc", "args": {}}])
    norm.handle_chunk(("updates", {"agent": {"messages": [ai]}}))
    out = norm.handle_chunk(("updates", {"agent": {"messages": [ai]}}))
    assert out == []


# ----------------------------------------------------------------------------
# updates mode — write_todos / plan snapshot dedup
# ----------------------------------------------------------------------------
def test_updates_write_todos_emits_plan_snapshot(agents_service):
    norm = _norm(agents_service)
    todos = [{"content": "step1", "status": "pending"}]
    ai = AIMessage(content="", tool_calls=[{"id": "wt-1", "name": "write_todos", "args": {"todos": todos}}])
    out = norm.handle_chunk(("updates", {"agent": {"messages": [ai]}}))
    assert _names(out) == ["PLAN_SNAPSHOT"]
    name, value = _custom_value(out[0])
    assert [{"content": i["content"], "status": i["status"]} for i in value["items"]] == todos
    assert "wt-1" in norm._silent_tools


def test_updates_write_todos_dedup_same_fingerprint(agents_service):
    norm = _norm(agents_service)
    todos = [{"content": "step1", "status": "pending"}]
    ai = AIMessage(content="", tool_calls=[{"id": "wt-1", "name": "write_todos", "args": {"todos": todos}}])
    norm.handle_chunk(("updates", {"agent": {"messages": [ai]}}))
    ai2 = AIMessage(content="", tool_calls=[{"id": "wt-2", "name": "write_todos", "args": {"todos": todos}}])
    out = norm.handle_chunk(("updates", {"agent": {"messages": [ai2]}}))
    # same fingerprint => no plan snapshot re-emitted
    assert out == []


def test_updates_write_todos_non_list_args_ignored(agents_service):
    norm = _norm(agents_service)
    ai = AIMessage(content="", tool_calls=[{"id": "wt-1", "name": "write_todos", "args": {"todos": "not-a-list"}}])
    out = norm.handle_chunk(("updates", {"agent": {"messages": [ai]}}))
    assert out == []
    assert "wt-1" in norm._silent_tools


def test_updates_authoritative_todos_snapshot(agents_service):
    norm = _norm(agents_service)
    todos = [{"content": "do it", "status": "in_progress"}]
    out = norm.handle_chunk(("updates", {"some_node": {"todos": todos}}))
    assert _names(out) == ["PLAN_SNAPSHOT"]
    name, value = _custom_value(out[0])
    assert [{"content": i["content"], "status": i["status"]} for i in value["items"]] == todos


def test_updates_metadata_forwarded_into_plan_snapshot(agents_service):
    norm = _norm(agents_service)
    todos = [{"content": "metafwd", "status": "pending"}]
    # non-HITL updates chunk WITH a metadata dict => meta.update(metadata) runs
    out = norm.handle_chunk(("updates", {"some_node": {"todos": todos}}, {"run_id": "r-42"}))
    assert _names(out) == ["PLAN_SNAPSHOT"]
    name, value = _custom_value(out[0])
    assert value["metadata"] == {"run_id": "r-42"}


def test_updates_authoritative_todos_dedup(agents_service):
    norm = _norm(agents_service)
    todos = [{"content": "do it", "status": "in_progress"}]
    norm.handle_chunk(("updates", {"some_node": {"todos": todos}}))
    out = norm.handle_chunk(("updates", {"some_node": {"todos": todos}}))
    assert out == []


class _FakeAI:
    """Minimal AI-like message; bypasses langchain's strict tool_call validation."""

    type = "ai"

    def __init__(self, content="", tool_calls=None):
        self.content = content
        self.tool_calls = tool_calls or []
        self.additional_kwargs = {}


# ----------------------------------------------------------------------------
# updates mode — final AI content synthesis
# ----------------------------------------------------------------------------
def test_updates_final_ai_content_updates_only(agents_service):
    norm = _norm(agents_service)
    ai = AIMessage(content="final answer", id="m-1")
    out = norm.handle_chunk(("updates", {"agent": {"messages": [ai]}}))
    # no prior messages chunk => synthesize start/content/end
    assert _types(out) == ["TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_END"]


def test_updates_final_ai_content_after_messages_chunk_only_closes(agents_service):
    norm = _norm(agents_service)
    # first a messages chunk
    norm.handle_chunk(("messages", AIMessageChunk(content="streamed")))
    ai = AIMessage(content="streamed final")
    out = norm.handle_chunk(("updates", {"agent": {"messages": [ai]}}))
    # response already started + saw_messages_chunk => only END
    assert _types(out) == ["TEXT_MESSAGE_END"]


def test_updates_ai_no_content_no_text_events(agents_service):
    norm = _norm(agents_service)
    ai = AIMessage(content="")
    out = norm.handle_chunk(("updates", {"agent": {"messages": [ai]}}))
    assert out == []


def test_updates_tool_message_result_path(agents_service):
    norm = _norm(agents_service)
    ai = AIMessage(content="", tool_calls=[{"id": "tc-5", "name": "lookup", "args": {}}])
    norm.handle_chunk(("updates", {"agent": {"messages": [ai]}}))
    tm = ToolMessage(content="done", tool_call_id="tc-5")
    out = norm.handle_chunk(("updates", {"tools": {"messages": [tm]}}))
    assert _types(out) == ["TOOL_CALL_RESULT", "TOOL_CALL_END"]


def test_updates_non_ai_non_tool_message_skipped(agents_service):
    norm = _norm(agents_service)
    out = norm.handle_chunk(("updates", {"agent": {"messages": [HumanMessage(content="hi")]}}))
    assert out == []


# ----------------------------------------------------------------------------
# updates mode — HITL interrupt priority
# ----------------------------------------------------------------------------
class _FakeInterrupt:
    def __init__(self, id, value):
        self.id = id
        self.value = value


def test_hitl_interrupt_with_object(agents_service):
    norm = _norm(agents_service)
    interrupt = _FakeInterrupt("int-1", {"question": "approve?"})
    out = norm.handle_chunk(("updates", {"__interrupt__": [interrupt]}))
    assert _names(out) == ["HITL_INTERRUPT"]
    name, value = _custom_value(out[0])
    assert value["interrupt"]["id"] == "int-1"
    assert value["interrupt"]["value"] == {"question": "approve?"}


def test_hitl_interrupt_with_metadata(agents_service):
    norm = _norm(agents_service)
    interrupt = _FakeInterrupt("int-2", "val")
    out = norm.handle_chunk(("updates", {"__interrupt__": [interrupt]}, {"run_id": "r-1"}))
    name, value = _custom_value(out[0])
    assert value["metadata"] == {"run_id": "r-1"}


def test_hitl_interrupt_empty_list_payload(agents_service):
    norm = _norm(agents_service)
    # __interrupt__ present but empty list => raw is falsy => interrupt_obj is the [] itself
    out = norm.handle_chunk(("updates", {"__interrupt__": []}))
    assert _names(out) == ["HITL_INTERRUPT"]
    name, value = _custom_value(out[0])
    # [] has no .id and no .value => id None, value falls back to the object ([])
    assert value["interrupt"] == {"id": None, "value": []}


def test_hitl_interrupt_explicit_none(agents_service):
    norm = _norm(agents_service)
    # __interrupt__ explicitly None => interrupt_obj is None => payload stays None
    out = norm.handle_chunk(("updates", {"__interrupt__": None}))
    assert _names(out) == ["HITL_INTERRUPT"]
    name, value = _custom_value(out[0])
    assert value["interrupt"] is None


def test_hitl_interrupt_bare_object_not_list(agents_service):
    norm = _norm(agents_service)
    interrupt = _FakeInterrupt("int-3", "v")
    out = norm.handle_chunk(("updates", {"__interrupt__": interrupt}))
    name, value = _custom_value(out[0])
    assert value["interrupt"]["id"] == "int-3"


# ----------------------------------------------------------------------------
# pure helpers — _extract_text_delta
# ----------------------------------------------------------------------------
def test_extract_text_delta_str(agents_service):
    assert agents_service.normalizer.message_text(AIMessageChunk(content="abc")) == "abc"


def test_extract_text_delta_list(agents_service):
    msg = AIMessageChunk(content=[{"type": "text", "text": "a"}, {"text": "b"}, {"foo": "bar"}])
    assert agents_service.normalizer.message_text(msg) == "ab"


def test_extract_text_delta_other_type(agents_service):

    class _M:
        content = 12345

    assert agents_service.normalizer.message_text(_M()) == ""


def test_extract_text_delta_missing_content(agents_service):

    class _M:
        pass

    assert agents_service.normalizer.message_text(_M()) == ""


# ----------------------------------------------------------------------------
# pure helpers — _iter_tool_calls
# ----------------------------------------------------------------------------
def test_iter_tool_calls_dict_shape(agents_service):
    ai = AIMessage(content="", tool_calls=[{"id": "a", "name": "n", "args": {"x": 1}}])
    calls = agents_service.normalizer.tool_calls(ai)
    assert calls == [{"id": "a", "name": "n", "args": {"x": 1}}]


def test_iter_tool_calls_none(agents_service):

    class _Msg:
        tool_calls = None
        additional_kwargs = {}

    assert agents_service.normalizer.tool_calls(_Msg()) == []


def test_iter_tool_calls_filters_missing_id_or_name(agents_service):
    ai = _FakeAI(
        tool_calls=[
            {"id": None, "name": "n", "args": {}},
            {"id": "a", "name": None, "args": {}},
            {"id": "b", "name": "ok", "args": {}},
        ],
    )
    calls = agents_service.normalizer.tool_calls(ai)
    assert calls == [{"id": "b", "name": "ok", "args": {}}]


# ----------------------------------------------------------------------------
# pure helpers — _messages_of
# ----------------------------------------------------------------------------
def test_unwrap_messages_list_none(agents_service):
    assert agents_service.normalizer._messages_of(None) == []


def test_unwrap_messages_list_overwrite_value(agents_service):

    class _Overwrite:
        value = ["m1", "m2"]

    assert agents_service.normalizer._messages_of(_Overwrite()) == ["m1", "m2"]


def test_unwrap_messages_list_plain_list(agents_service):
    assert agents_service.normalizer._messages_of(["a", "b"]) == ["a", "b"]


def test_unwrap_messages_list_single_message(agents_service):
    m = HumanMessage(content="x")
    assert agents_service.normalizer._messages_of(m) == [m]


# ----------------------------------------------------------------------------
# run memory across resume (thread-keyed)
# ----------------------------------------------------------------------------
def _launch(norm, call_id="call-1"):
    """A ``start_async_task`` result naming its task: TASK_LAUNCHED, once per run."""
    result = ToolMessage(content="Launched async subagent. task_id: t-1", tool_call_id=call_id, name="start_async_task")
    return [f for f in norm.handle_chunk(("messages", result)) if _decode(f).get("name") == "TASK_LAUNCHED"]


def test_a_launch_is_announced_once_across_a_resume(agents_service):
    mod = agents_service.normalizer
    assert len(_launch(mod.AGUIStreamNormalizer(thread_id="thread-r"))) == 1
    # A fresh /resume normalizer for the same run replays the result: not again.
    assert _launch(mod.AGUIStreamNormalizer(thread_id="thread-r")) == []


def test_release_run_memory_clears_store(agents_service):
    mod = agents_service.normalizer
    _launch(mod.AGUIStreamNormalizer(thread_id="thread-release-1"))
    mod.release_run_memory("thread-release-1")
    assert len(_launch(mod.AGUIStreamNormalizer(thread_id="thread-release-1"))) == 1


def test_run_memory_is_isolated_per_thread(agents_service):
    mod = agents_service.normalizer
    _launch(mod.AGUIStreamNormalizer(thread_id="thread-A"))
    assert len(_launch(mod.AGUIStreamNormalizer(thread_id="thread-B"))) == 1
    mod.release_run_memory("thread-A")
    mod.release_run_memory("thread-B")


def test_empty_thread_id_does_not_persist(agents_service):
    # Threadless runs never resume, so nothing is persisted under "" (avoids
    # cross-run leakage).
    mod = agents_service.normalizer
    _launch(mod.AGUIStreamNormalizer(thread_id=""))
    assert len(_launch(mod.AGUIStreamNormalizer(thread_id=""))) == 1
    assert "" not in mod._RUNS


# ----------------------------------------------------------------------------
# pure helpers — _msg_kind
# ----------------------------------------------------------------------------
def test_msg_kind_tool_via_tool_call_id(agents_service):
    assert agents_service.normalizer.message_kind(ToolMessage(content="x", tool_call_id="t")) == "tool"


def test_msg_kind_ai(agents_service):
    assert agents_service.normalizer.message_kind(AIMessage(content="x")) == "ai"
    assert agents_service.normalizer.message_kind(AIMessageChunk(content="x")) == "ai"


def test_msg_kind_other(agents_service):
    assert agents_service.normalizer.message_kind(HumanMessage(content="x")) == "other"


def test_msg_kind_role_assistant(agents_service):

    class _M:
        role = "assistant"
        tool_call_id = None
        type = None

    assert agents_service.normalizer.message_kind(_M()) == "ai"


def test_msg_kind_role_tool(agents_service):

    class _M:
        role = "tool"
        tool_call_id = None
        type = "tool"

    assert agents_service.normalizer.message_kind(_M()) == "tool"


# ----------------------------------------------------------------------------
# state helpers
# ----------------------------------------------------------------------------
# ----------------------------------------------------------------------------
# thinking_end transition
# ----------------------------------------------------------------------------
# ----------------------------------------------------------------------------
# ask_user — its interrupt is its only UI
# ----------------------------------------------------------------------------
def _ask_user_call(call_id="ask-1"):
    return AIMessage(
        content="",
        tool_calls=[{"id": call_id, "name": "ask_user", "args": {"questions": [{"question": "Which period?"}]}}],
    )


def test_ask_user_call_emits_no_tool_lifecycle(agents_service):
    norm = _norm(agents_service)
    out = norm.handle_chunk(("updates", {"model": {"messages": [_ask_user_call()]}}))
    assert out == []
    assert "ask-1" in norm._silent_tools
    # Its result (after the resume) is swallowed too, and the id is released.
    result = norm.handle_chunk(("messages", ToolMessage(content="The user answered", tool_call_id="ask-1")))
    assert result == []
    assert "ask-1" not in norm._silent_tools


def test_ask_user_interrupt_still_reaches_the_client_unchanged(agents_service):
    norm = _norm(agents_service)
    norm.handle_chunk(("updates", {"model": {"messages": [_ask_user_call()]}}))
    panel = {
        "type": "ask_user",
        "questions": [{"id": "q1", "question": "Which period?", "options": ["Q3", "Q4"], "multiple": False}],
    }
    out = norm.handle_chunk(("updates", {"__interrupt__": [_FakeInterrupt("int-ask", panel)]}))
    assert _names(out) == ["HITL_INTERRUPT"]
    _, value = _custom_value(out[0])
    assert value["interrupt"] == {"id": "int-ask", "value": panel}


def test_ask_user_result_on_a_fresh_resume_normalizer_is_dropped(agents_service):
    # /resume builds a new normalizer that never saw the call: the result must
    # not surface as an orphan TOOL_CALL_RESULT.
    norm = _norm(agents_service, thread_id="t-resume")
    out = norm.handle_chunk(("messages", ToolMessage(content="The user answered", tool_call_id="ask-1")))
    assert out == []


def test_a_resume_does_not_repeat_the_text_and_usage_of_the_approved_message(agents_service):
    # After an approval, HumanInTheLoopMiddleware.after_model re-emits the AI
    # message the model node streamed before the pause (text and usage
    # included). The fresh /resume normalizer must show only its tool call.
    reply = AIMessage(
        id="ai-1",
        content="I'll start a slow task now.",
        tool_calls=[{"name": "danger", "args": {"target": "x"}, "id": "c1"}],
        usage_metadata={"input_tokens": 5, "output_tokens": 1, "total_tokens": 6},
    )
    norm = _norm(agents_service, thread_id="t-resume")
    frames = norm.handle_chunk(("updates", {"HumanInTheLoopMiddleware.after_model": {"messages": [reply]}}))
    assert _names(frames) == ["TOOL_CALL_START", "TOOL_CALL_ARGS"]
