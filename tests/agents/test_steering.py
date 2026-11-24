"""Steering on the agents side (SSE plan, phase 5).

Pinned: ``SteeringMiddleware`` asks the bridge for the waiting message only
when the run's doorbell is rung; a claimed message enters the state as a
marked ``HumanMessage`` *after* the step's tool results and before the next
model call, which sees it; nothing to claim, a bridge error or a Redis error
all leave the step alone (the bridge sends the message at the run end). The
normalizer turns the message into ``USER_INTERJECTION`` (never a task
notification); the middleware and its prompt section exist only for an
interactive run that knows its user, conversation and run, with the switch on.
"""
from __future__ import annotations

import importlib
import json
from typing import Any, ClassVar

import fakeredis.aioredis
import httpx
import pytest
from langchain.agents import create_agent
from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langchain_core.tools import tool
from redis.exceptions import ConnectionError as RedisConnectionError

RUN_ID = "run-1"
CONTEXT = {"user_id": "u-1", "conversation_id": "c-1", "run_id": RUN_ID}


class _Scripted(FakeMessagesListChatModel):
    """Replays scripted replies and records what the model was shown."""

    seen: ClassVar[list] = []

    def bind_tools(self, tools, **kwargs):
        return self

    def _generate(self, messages, *args, **kwargs):
        type(self).seen.append(list(messages))
        return super()._generate(messages, *args, **kwargs)


@tool
def lookup(query: str) -> str:
    """Look something up."""
    return f"found {query}"


@pytest.fixture
def steering(agents_service):
    return importlib.import_module("harness.middlewares.steering")


@pytest.fixture
def redis_client():
    return fakeredis.aioredis.FakeRedis(decode_responses=True)


@pytest.fixture
def bridge(monkeypatch, steering):
    """The bridge's claim endpoint, scripted: a list of (status, body) answers."""
    state: dict[str, Any] = {"answers": [], "requests": []}

    def handler(request: httpx.Request) -> httpx.Response:
        state["requests"].append({"url": str(request.url), "json": json.loads(request.content)})
        status, body = state["answers"].pop(0) if state["answers"] else (204, None)
        if isinstance(status, Exception):
            raise status
        return httpx.Response(status, json=body) if body is not None else httpx.Response(status)

    real_client = httpx.AsyncClient

    class _Client(real_client):
        def __init__(self, **kwargs):
            kwargs.pop("verify", None)
            kwargs.pop("cert", None)
            super().__init__(transport=httpx.MockTransport(handler), **kwargs)

    monkeypatch.setattr(steering.httpx, "AsyncClient", _Client)
    return state


def _middleware(steering, redis_client):
    return steering.SteeringMiddleware(
        user_id="u-1", conversation_id="c-1", run_id=RUN_ID, redis_client=redis_client
    )


# ---------------------------------------------------------------------------
# The middleware
# ---------------------------------------------------------------------------
async def test_no_doorbell_no_call(steering, redis_client, bridge):
    update = await _middleware(steering, redis_client).abefore_model({"messages": []}, None)

    assert update is None
    assert bridge["requests"] == []


async def test_a_rung_doorbell_claims_the_message_into_the_state(steering, redis_client, bridge):
    await redis_client.set(steering.steer_key(RUN_ID), "1")
    bridge["answers"].append((200, {"messages": [{"content": "focus on Y", "queued_at": "2026-11-23T10:00:00Z"}]}))

    update = await _middleware(steering, redis_client).abefore_model({"messages": []}, None)

    [message] = update["messages"]
    assert isinstance(message, HumanMessage)
    assert message.content == "focus on Y"
    assert message.additional_kwargs == {
        "lc_source": "user_interjection", "lc_data": {"queued_at": "2026-11-23T10:00:00Z"},
    }
    [request] = bridge["requests"]
    assert request["url"].endswith("/v1/internal/conversations/c-1/interjection/claim")
    assert request["json"] == {"user_id": "u-1", "run_id": RUN_ID}


async def test_several_waiting_messages_enter_as_separate_messages_in_order(steering, redis_client, bridge):
    await redis_client.set(steering.steer_key(RUN_ID), "1")
    bridge["answers"].append((200, {"messages": [
        {"content": "only 2025", "queued_at": "2026-11-24T10:00:00Z"},
        {"content": "and in euros", "queued_at": "2026-11-24T10:00:05Z"},
    ]}))

    update = await _middleware(steering, redis_client).abefore_model({"messages": []}, None)

    assert [m.content for m in update["messages"]] == ["only 2025", "and in euros"]
    assert all(m.additional_kwargs["lc_source"] == "user_interjection" for m in update["messages"])


@pytest.mark.parametrize("answer", [(204, None), (503, {"detail": "down"}), (httpx.ConnectTimeout("slow"), None)])
async def test_nothing_to_claim_or_a_failing_bridge_leaves_the_step_alone(steering, redis_client, bridge, answer):
    await redis_client.set(steering.steer_key(RUN_ID), "1")
    bridge["answers"].append(answer)

    assert await _middleware(steering, redis_client).abefore_model({"messages": []}, None) is None


async def test_a_redis_failure_reads_as_nothing_waiting(steering, bridge):
    class _Down:
        async def exists(self, *_args):
            raise RedisConnectionError("refused")

    middleware = steering.SteeringMiddleware(user_id="u-1", conversation_id="c-1", run_id=RUN_ID, redis_client=_Down())

    assert await middleware.abefore_model({"messages": []}, None) is None
    assert bridge["requests"] == []


def test_only_an_interactive_run_with_its_ids_steers(steering, monkeypatch):
    assert isinstance(steering.build_steering_middleware(CONTEXT, interactive=True), steering.SteeringMiddleware)
    assert steering.build_steering_middleware(CONTEXT, interactive=False) is None
    assert steering.build_steering_middleware({**CONTEXT, "run_id": None}, interactive=True) is None
    assert steering.build_steering_middleware(None, interactive=True) is None
    monkeypatch.setattr(steering.settings.steering, "enabled", False)
    assert steering.build_steering_middleware(CONTEXT, interactive=True) is None


# ---------------------------------------------------------------------------
# In a real agent loop
# ---------------------------------------------------------------------------
async def test_the_next_model_call_sees_the_message_after_the_tool_results(
    steering, redis_client, bridge, agents_service
):
    normalizer = agents_service.normalizer
    await redis_client.set(steering.steer_key(RUN_ID), "1")
    # Nothing before the first call; the message arrives during the tool step.
    bridge["answers"].extend([(204, None), (200, {"messages": [{"content": "only the 2025 numbers", "queued_at": None}]})])
    _Scripted.seen = []
    model = _Scripted(responses=[
        AIMessage(content="", tool_calls=[{"id": "call-1", "name": "lookup", "args": {"query": "revenue"}}]),
        AIMessage(content="Here are the 2025 numbers."),
    ])
    agent = create_agent(model=model, tools=[lookup], middleware=[_middleware(steering, redis_client)])

    norm = normalizer.AGUIStreamNormalizer(thread_id="t-steer")
    frames: list[bytes] = []
    async for chunk in agent.astream({"messages": [HumanMessage(content="revenue?")]}, stream_mode=["updates"]):
        frames.extend(norm.handle_chunk(chunk))

    second_call = _Scripted.seen[1]
    assert [type(m).__name__ for m in second_call[-3:]] == ["AIMessage", "ToolMessage", "HumanMessage"]
    assert isinstance(second_call[-2], ToolMessage)
    assert second_call[-1].content == "only the 2025 numbers"

    events = [json.loads(f.decode().split("data:", 1)[1]) for f in frames]
    interjections = [e["value"] for e in events if e.get("type") == "CUSTOM" and e.get("name") == "USER_INTERJECTION"]
    assert interjections == [{"text": "only the 2025 numbers"}]
    assert not [e for e in events if e.get("name") == "TASK_SETTLED_INLINE"]


def test_a_message_repeated_by_a_later_update_is_announced_once(agents_service):
    normalizer = agents_service.normalizer
    normalizer._RUNS.clear()
    message = HumanMessage(
        content="and in euros",
        additional_kwargs={"lc_source": "user_interjection", "lc_data": {"queued_at": "2026-11-23T10:00:00Z"}},
    )
    norm = normalizer.AGUIStreamNormalizer(thread_id="t-dup")
    first = norm.handle_chunk(("updates", {"SteeringMiddleware.before_model": {"messages": [message]}}))
    # The same message again, as a later node's update (or a resumed stream) carries it.
    again = normalizer.AGUIStreamNormalizer(thread_id="t-dup").handle_chunk(
        ("updates", {"SomeMiddleware.before_model": {"messages": [message.model_copy(update={"id": "m-1"})]}})
    )
    normalizer._RUNS.clear()

    assert len(first) == 1
    assert again == []


# ---------------------------------------------------------------------------
# The prompt section
# ---------------------------------------------------------------------------
def test_the_prompt_explains_mid_task_messages_only_when_the_run_reads_them(agents_service):
    context_mod = importlib.import_module("harness.prompt_engineering.context")
    composer = importlib.import_module("harness.prompt_engineering.composer")

    on = composer.describe_sections(context_mod.PromptContext(reads_interjections=True))
    off = composer.describe_sections(context_mod.PromptContext())

    assert "steering" in on
    assert "steering" not in off
