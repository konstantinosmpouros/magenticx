"""LangGraph stream chunks -> AG-UI events.

A deep agent streams ``["messages", "updates"]``:

* ``messages`` - token chunks: the reply text and the reasoning summary.
* ``updates``  - settled node outputs: tool calls and results, the plan,
  interrupts, token usage, pulled task notifications, and the user's messages
  read mid-run (steering).

Nothing runs nested in the graph: every sub-agent is a background task (plan
41) streaming on its own thread through a normalizer of its own, so one
normalizer always speaks for one actor — the run's own agent.
"""

import json
import mimetypes
import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

from pydantic import ValidationError

from core.logging import get_logger
from harness.agui.emitter import AGUIEmitter, Event, encode
from harness.middlewares.sources import SOURCES_KEY
from harness.middlewares.steering import INTERJECTION_DATA_KEY, INTERJECTION_SOURCE
from harness.middlewares.summarization import COMPACTION_KEY
from harness.middlewares.tool_metrics import TOOL_METRICS_KEY
from harness.middlewares.usage_metrics import METRICS_KEY as USAGE_METRICS_KEY
from harness.tools.charts import normalize_chart_payload

logger = get_logger(__name__)

_MODES = {"messages", "updates"}

START_ASYNC_TASK_TOOL_NAME = "start_async_task"
UPDATE_ASYNC_TASK_TOOL_NAME = "update_async_task"

# ``Launched async subagent. task_id: <id>`` (deepagents 0.7.34); an update to
# a waiting task ends its sentence right after the id.
_LAUNCHED_TASK_ID_RE = re.compile(r"task_id:\s*([A-Za-z0-9_-]+)")

# A task notification deepagents pulls into a running agent's state
# (``add_notification_metadata``): ``lc_source`` + ``lc_data``, or the
# deprecated ``deepagents_notification`` key.
_NOTIFICATION_SOURCE = "async_subagent"
_NOTIFICATION_DATA_KEY = "lc_data"
_NOTIFICATION_LEGACY_KEY = "deepagents_notification"
# Notification status -> settled status the UI shows (``waiting`` is not settled).
_SETTLED_INLINE_STATUS = {"success": "success", "error": "error", "timeout": "error", "cancelled": "cancelled"}


# --------------------------------------------------------------------------
# What one run remembers across its streams
# --------------------------------------------------------------------------
@dataclass
class _RunMemory:
    """Kept per run id across its streams (a /resume builds a fresh normalizer).

    Single worker, same lifecycle as the checkpointer cache.
    """

    launched: set[str] = field(default_factory=set)  # TASK_LAUNCHED sent (a resume replays results)
    # USER_INTERJECTION sent, by (text, queued_at): a later state update can
    # carry the same message again (with its id by then), and a resume replays.
    interjections: set[tuple[str, str | None]] = field(default_factory=set)


_RUNS: dict[str, _RunMemory] = {}


def release_run_memory(thread_id: str) -> None:
    """Forget a finished (or fresh) run."""
    _RUNS.pop(thread_id, None)


# --------------------------------------------------------------------------
# Reading LangChain messages
# --------------------------------------------------------------------------
def message_kind(msg: Any) -> str:
    """``tool``, ``ai`` or ``other``, by duck typing (chunks and dicts too)."""
    mtype = getattr(msg, "type", None)
    role = getattr(msg, "role", None)
    cls = type(msg).__name__
    if getattr(msg, "tool_call_id", None) is not None or "tool" in (role, mtype) or cls == "ToolMessage":
        return "tool"
    if role == "assistant" or mtype in ("ai", "assistant") or "AIMessage" in cls:
        return "ai"
    return "other"


def _blocks(msg: Any) -> list[dict[str, Any]]:
    """The message's content as LangChain standard blocks (any provider), else its raw list.

    ``content_blocks`` translates by ``response_metadata["model_provider"]``,
    which every integration sets; a provider's translator can raise on a
    malformed block.
    """
    try:
        blocks = msg.content_blocks
    except Exception:
        blocks = getattr(msg, "content", None)
    return [b for b in blocks if isinstance(b, dict)] if isinstance(blocks, list) else []


def message_text(msg: Any) -> str:
    """The reply text of a message (never its reasoning or tool input)."""
    content = getattr(msg, "content", "")
    if isinstance(content, str):
        return content
    return "".join(
        b["text"] for b in _blocks(msg) if b.get("type") == "text" and isinstance(b.get("text"), str)
    )


def tool_calls(msg: Any) -> list[dict[str, Any]]:
    """The message's tool calls as ``{id, name, args}`` (every integration fills ``tool_calls``)."""
    return [
        {"id": tc.get("id"), "name": tc.get("name"), "args": tc.get("args")}
        for tc in getattr(msg, "tool_calls", None) or []
        if isinstance(tc, dict) and tc.get("id") and tc.get("name")
    ]


def reasoning_parts(msg: Any) -> list[tuple[str, str]]:
    """The reasoning text of an AI message (chunk), as ``(part key, text)`` in order.

    Standard ``reasoning`` blocks (OpenAI summaries, Anthropic and Bedrock
    thinking, Gemini thoughts, DeepSeek/xAI/Groq ``reasoning_content``), and
    the raw shapes when the message names no provider. The key tells one part
    from the next: the block's index, else its position.
    """
    parts: list[tuple[str, str]] = []
    for pos, block in enumerate(_blocks(msg)):
        if block.get("type") == "non_standard" and isinstance(block.get("value"), dict):
            block = block["value"]
        index = block.get("index")
        key = str(index) if index is not None else f"#{pos}"
        kind = block.get("type")
        if kind == "reasoning" and isinstance(block.get("summary"), list):  # raw OpenAI Responses
            for part in block["summary"]:
                if isinstance(part, dict) and isinstance(part.get("text"), str) and part["text"]:
                    parts.append((f"{key}:{part.get('index', '')}", part["text"]))
        elif kind == "reasoning" and isinstance(block.get("reasoning"), str) and block["reasoning"]:
            parts.append((key, block["reasoning"]))
        elif kind == "thinking" and isinstance(block.get("thinking"), str) and block["thinking"]:
            parts.append((key, block["thinking"]))
    if not parts:  # the openai translator skips this OpenAI-compatible field
        extra = getattr(msg, "additional_kwargs", None) or {}
        if isinstance(extra.get("reasoning_content"), str) and extra["reasoning_content"]:
            parts.append(("#rc", extra["reasoning_content"]))
    return parts


def _merge_parts(parts: list[tuple[str, str]]) -> list[tuple[str, str]]:
    """Join consecutive pieces of the same part."""
    merged: list[tuple[str, str]] = []
    for key, text in parts:
        if merged and merged[-1][0] == key:
            merged[-1] = (key, merged[-1][1] + text)
        else:
            merged.append((key, text))
    return merged


def _messages_of(value: Any) -> list[Any]:
    """A node update's ``messages``: a list, an ``Overwrite(value=[...])`` or one message."""
    if value is None:
        return []
    inner = getattr(value, "value", None)
    if isinstance(inner, list):
        return inner
    return value if isinstance(value, list) else [value]


@dataclass
class _Reply:
    """The reply text of the current model call."""

    started: bool = False  # TEXT_MESSAGE_START sent
    streamed: bool = False  # chunks came over "messages": the final message must not repeat them


@dataclass
class _Call:
    """A tool call with the metadata of the update it came in."""

    id: str
    name: str
    args: dict[str, Any] | None
    meta: dict[str, Any]


@dataclass
class _Thought:
    """The current reasoning-summary part, streamed as it arrives.

    One part is one thought step in the UI: THINKING_TEXT_MESSAGE_START when
    its first visible text arrives, a CONTENT event per streamed piece, END
    when the next part (or the reply, or the settle) begins.
    """

    part: str | None = None
    sent: bool = False  # this part's THINKING_TEXT_MESSAGE_START is out, its END not yet
    streamed: bool = False  # this model call's parts came over "messages"
    open: bool = False  # THINKING_START sent, THINKING_END not yet


class AGUIStreamNormalizer:
    """Turns one stream of a deep agent run into AG-UI SSE frames.

    Every tool call gets the full start/args/result/end lifecycle except:

    ====================  ===================================================
    ``write_todos``       PLAN_SNAPSHOT (deduplicated)
    ``present_artifact``  PRESENT_ARTIFACT card
    ``render_chart``      RENDER_CHART inline chart
    ``ask_user``          nothing: its interrupt is the HITL event
    ``start_async_task``  TASK_LAUNCHED on its result (a failed launch: an
    ``update_async_task`` errored tool card)
    ====================  ===================================================

    An interrupt is sent as HITL_INTERRUPT alone. A task notification pulled
    into the run becomes TASK_SETTLED_INLINE, never user text.
    """

    def __init__(self, thread_id: str) -> None:
        self.emitter = AGUIEmitter()
        self.thread_id = thread_id  # the run id: every AG-UI message_id
        self._run = _RUNS.setdefault(thread_id, _RunMemory()) if thread_id else _RunMemory()

        self._reply = _Reply()  # the current model call's reply text
        self._thought = _Thought()  # the current model call's reasoning
        self._last_plan: str | None = None

        # Tool calls.
        self._open_tools: set[str] = set()  # start/args sent, result awaited
        self._started_tools: set[str] = set()
        self._finished_tools: set[str] = set()
        self._silent_tools: set[str] = set()  # their ToolMessage is never a tool card

        # Tools with an event of their own instead of a tool card.
        self._special_tools = {
            "write_todos": self._plan_call,
            "present_artifact": self._present_artifact_call,
            "ask_user": self._ask_user_call,
            "render_chart": self._render_chart_call,
            START_ASYNC_TASK_TOOL_NAME: self._async_task_call,
            UPDATE_ASYNC_TASK_TOOL_NAME: self._async_task_call,
        }

        # Background tasks.
        self._async_calls: dict[str, dict[str, Any]] = {}  # start/update call -> what its result needs
        self._settled_inline: set[tuple[str, str, str]] = set()  # (task, run, status) sent

        # Automatic compaction: open from the summary call to the reply after it.
        self._compaction_open = False
        self._compactions = 0
        self._compaction_usage_ids: set[str] = set()

    # ------------------------------------------------------------------ API
    def handle_chunk(self, chunk: Any) -> list[bytes]:
        """One raw stream chunk -> 0..N AG-UI SSE frames."""
        mode, payload, metadata = self._unwrap(chunk)
        if mode == "messages":
            events = self._on_message(payload, metadata)
        elif mode == "updates":
            events = self._on_updates(payload, metadata)
        else:
            events = []
        return [encode(event) for event in events]

    def seed_pending_tasks(self, messages: Any) -> None:
        """Before a /resume stream: re-learn the task calls still awaiting a result.

        A gated ``start_async_task`` / ``update_async_task`` was announced on the
        previous stream, so without this its launch would lose what it asked for
        once the approval lets it run.
        """
        answered = {
            str(msg.tool_call_id) for msg in _messages_of(messages)
            if message_kind(msg) == "tool" and getattr(msg, "tool_call_id", None)
        }
        for msg in _messages_of(messages):
            if message_kind(msg) != "ai":
                continue
            for tc in tool_calls(msg):
                call_id, name = str(tc["id"]), tc["name"]
                args = tc["args"] if isinstance(tc["args"], dict) else {}
                if call_id in answered:
                    continue
                if name in (START_ASYNC_TASK_TOOL_NAME, UPDATE_ASYNC_TASK_TOOL_NAME):
                    self._async_calls.setdefault(call_id, self._async_call(name, args))
                    self._silent_tools.add(call_id)

    # ------------------------------------------------------------- envelope
    @staticmethod
    def _unwrap(chunk: Any) -> tuple[str | None, Any, dict[str, Any] | None]:
        """``(mode, payload, metadata)``; a "messages" payload is ``(msg, metadata)``."""
        if isinstance(chunk, dict):
            return "updates", chunk, None
        if not isinstance(chunk, (tuple, list)):
            return None, chunk, None
        for idx, item in enumerate(chunk):
            if isinstance(item, str) and item in _MODES:
                payload = chunk[idx + 1] if idx + 1 < len(chunk) else chunk
                after = chunk[idx + 2] if idx + 2 < len(chunk) else None
                metadata = after if isinstance(after, dict) else None
                if item == "messages" and isinstance(payload, tuple) and len(payload) == 2 and metadata is None:
                    payload, meta = payload
                    metadata = meta if isinstance(meta, dict) else None
                return item, payload, metadata
        return None, chunk, None

    # -------------------------------------------------------- messages mode
    def _on_message(self, msg: Any, metadata: dict[str, Any] | None) -> list[Event]:
        """A token chunk: reasoning (streamed per part) and reply text; or a tool result."""
        if isinstance(metadata, dict) and metadata.get("lc_source") == "summarization":
            # A compaction's internal summary call: never the reply.
            return self._on_summary_call(msg)
        out: list[Event] = []
        kind = message_kind(msg)
        if kind == "tool":
            self._on_tool_result(out, msg)
        elif kind == "ai":
            for part_key, text in reasoning_parts(msg):
                self._buffer_thought(out, part_key, text)
            delta = message_text(msg)
            if delta:
                self._flush_thought(out)  # the reply starts: the reasoning is complete
                self._open_reply(out)
                self._add(out, self.emitter.response_chunk(message_id=self.thread_id, delta=delta))
                self._reply.streamed = True
        return out

    # --------------------------------------------------------- updates mode
    def _on_updates(self, payload: Any, metadata: dict[str, Any] | None) -> list[Event]:
        out: list[Event] = []
        if not isinstance(payload, dict):
            return out
        meta = dict(metadata or {})

        if "__interrupt__" in payload:  # the interrupt alone
            raw = payload["__interrupt__"]
            interrupt = raw[0] if isinstance(raw, (tuple, list)) and raw else raw
            value = None if interrupt is None else {
                "id": getattr(interrupt, "id", None), "value": getattr(interrupt, "value", interrupt),
            }
            self._add(out, self.emitter.hitl_interrupt(thread_id=self.thread_id, interrupt=value, metadata=meta))
            return out

        for node, update in payload.items():
            if not isinstance(update, dict):
                continue
            if isinstance(update.get("todos"), list):
                self._plan(out, update["todos"], meta)
            for msg in _messages_of(update.get("messages")):
                kind = message_kind(msg)
                if kind == "tool":
                    self._on_tool_result(out, msg)
                elif kind == "ai":
                    self._on_model_reply(out, msg, node, meta)
                elif not self._on_interjection(out, msg):
                    self._on_task_notification(out, msg, node, update)
        return out

    def _on_model_reply(self, out: list[Event], msg: Any, node: Any, meta: dict[str, Any]) -> None:
        """A settled model call: reasoning, then text, usage and tool calls.

        A middleware node (``Name.hook``) re-emits a message the model node
        already sent (HITL after_model on a resume, compaction): only its tool
        calls can be new.
        """
        reemitted = isinstance(node, str) and "." in node
        if not reemitted:
            self._settle_thoughts(out, msg)
            text = message_text(msg)
            if text:
                self._open_reply(out)
                if not self._reply.streamed:  # updates-only stream: the text comes from here
                    self._add(out, self.emitter.response_content(message_id=self.thread_id, delta=text))
                self._add(out, self.emitter.response_end(message_id=self.thread_id))
            self._reply = _Reply()  # the model call is over: its text message too
            self._usage(out, msg)
        for tc in tool_calls(msg):
            self._on_tool_call(out, tc, meta)

    # ----------------------------------------------------------- reply text
    def _open_reply(self, out: list[Event]) -> None:
        """TEXT_MESSAGE_START once per model call (ending the thinking before it)."""
        if not self._reply.started:
            self._close_thinking(out)
            self._add(out, self.emitter.response_start(message_id=self.thread_id))
            self._reply.started = True

    # -------------------------------------------------------------- thoughts
    def _buffer_thought(self, out: list[Event], key: str, text: str) -> None:
        """A streamed piece of a summary part, sent on at once; a new part ends the one before.

        Held back only until the part has visible text, so a part that never
        says anything opens no step. (Holding whole parts made the reasoning
        appear as one block after a pause — the lag users saw.)
        """
        thought = self._thought
        if thought.part is not None and thought.part != key:
            self._flush_thought(out)
        thought.part, thought.streamed = key, True
        if not thought.sent:
            text = text.lstrip()
            if not text:
                return
            if not thought.open:
                thought.open = True
                self._add(out, self.emitter.thinking_start())
            self._add(out, self.emitter.thought_start())
            thought.sent = True
        self._add(out, self.emitter.thought_delta(text))

    def _flush_thought(self, out: list[Event]) -> None:
        """End the part being streamed (the UI shows each part as one step)."""
        thought = self._thought
        if thought.sent:
            self._add(out, self.emitter.thought_end())
        thought.part, thought.sent = None, False

    def _send_thought(self, out: list[Event], text: str) -> None:
        """One thought: THINKING_START once per thinking phase, then the thought as a
        start/content/end text message (the UI shows each as a step)."""
        if not self._thought.open:
            self._thought.open = True
            self._add(out, self.emitter.thinking_start())
        out.extend(self.emitter.thought(text))

    def _close_thinking(self, out: list[Event]) -> None:
        """The reply starts: the thinking phase before it ends (a thought still open first)."""
        self._flush_thought(out)
        if self._thought.open:
            self._thought.open = False
            self._add(out, self.emitter.thinking_end())

    def _settle_thoughts(self, out: list[Event], msg: Any) -> None:
        """The model call settled: the part still held, or (updates-only) every part of it."""
        if self._thought.streamed:
            self._flush_thought(out)
        else:
            for _key, text in _merge_parts(reasoning_parts(msg)):
                if text.strip():
                    self._send_thought(out, text.strip())
        self._thought.streamed = False

    # ------------------------------------------------------------ tool calls
    def _on_tool_call(self, out: list[Event], tc: dict[str, Any], meta: dict[str, Any]) -> None:
        """A tool call: a tool card, or the special tool's own event (its result is then no card)."""
        call = _Call(tc["id"], tc["name"], tc["args"] if isinstance(tc["args"], dict) else None, meta)
        special = self._special_tools.get(call.name)
        if special is not None:
            special(out, call)
            self._silent_tools.add(call.id)
        elif call.id not in self._started_tools:
            self._tool_card_open(out, call.id, call.name, tc["args"])
            self._open_tools.add(call.id)

    def _plan_call(self, out: list[Event], call: _Call) -> None:
        if call.args is not None and isinstance(call.args.get("todos"), list):
            self._plan(out, call.args["todos"], call.meta)

    def _present_artifact_call(self, out: list[Event], call: _Call) -> None:
        """A finished file handed to the user."""
        if call.args is None:
            return
        path, title = str(call.args.get("path", "")).strip(), str(call.args.get("title", "")).strip()
        if not (path and title):
            return
        filename = path.rstrip("/").rsplit("/", 1)[-1]
        self._add(out, self.emitter.present_artifact(
            artifact_id=call.id, path=path, filename=filename, title=title,
            summary=str(call.args.get("summary") or "").strip() or None,
            mime=mimetypes.guess_type(filename)[0],
        ))

    def _ask_user_call(self, out: list[Event], call: _Call) -> None:
        """Nothing: its interrupt (the questions) is the event, its result comes on /resume."""

    def _render_chart_call(self, out: list[Event], call: _Call) -> None:
        """A chart the agent drew, normalized here (bounded, coerced, only the
        plotted fields): a renderable chart or nothing."""
        if call.args is None:
            return
        payload = normalize_chart_payload(call.args)
        if payload is not None:
            self._add(out, self.emitter.render_chart(chart_id=call.id, **payload))

    def _async_task_call(self, out: list[Event], call: _Call) -> None:
        """A background task start/update: its result becomes the event."""
        self._async_calls.setdefault(call.id, self._async_call(call.name, call.args or {}))

    def _tool_card_open(self, out: list[Event], call_id: str, name: str, args: Any) -> None:
        self._add(out, self.emitter.tool_call_start(tool_call_id=call_id, name=name))
        self._add(out, self.emitter.tool_call_args(tool_call_id=call_id, name=name, args=args))
        self._started_tools.add(call_id)

    def _tool_card_close(self, out: list[Event], call_id: str, msg: Any, *, error: bool) -> None:
        """The result and end of a tool card, then its TOOL_USAGE and SOURCES.

        A result that carries valid sources (plan 42) is not sent as text: the
        card shows its pages from the SOURCES event, and the page contents — the
        model's reading, not the user's — never leave the agents service. A
        malformed stamp sends the result as before, so the card is never empty.
        """
        sources = None if error else self._sources_event(msg, call_id)
        self._add(out, self.emitter.tool_call_result(
            tool_call_id=call_id, thread_id=self.thread_id,
            output="" if sources is not None else getattr(msg, "content", ""), error=error,
        ))
        self._add(out, self.emitter.tool_call_end(tool_call_id=call_id))
        self._tool_usage(out, msg, call_id)
        if sources is not None:
            self._add(out, sources)
        self._open_tools.discard(call_id)
        self._finished_tools.add(call_id)

    def _tool_usage(self, out: list[Event], msg: Any, call_id: str) -> None:
        """TOOL_USAGE from the stamp ``ToolMetricsMiddleware`` put on the result, when
        there is one. Telemetry never breaks the stream: a malformed stamp is logged and dropped."""
        stamp = (getattr(msg, "response_metadata", None) or {}).get(TOOL_METRICS_KEY)
        if not isinstance(stamp, dict):
            return
        try:
            self._add(out, self.emitter.tool_usage(
                tool_call_id=call_id, tool_name=stamp.get("tool_name") or getattr(msg, "name", None) or "tool",
                duration_ms=stamp.get("duration_ms"), status=stamp.get("status"),
                output_chars=stamp.get("output_chars"),
            ))
        except ValidationError:
            logger.warning("tool_usage_skipped", "Malformed tool metrics on a tool result", tool_call_id=call_id)

    def _sources_event(self, msg: Any, call_id: str) -> Event | None:
        """The SOURCES event for the stamp ``SourcesMiddleware`` put on the result,
        or None. Citations never break the stream: a malformed stamp is logged
        (counts only, never a URL) and dropped."""
        stamp = (getattr(msg, "response_metadata", None) or {}).get(SOURCES_KEY)
        if not stamp:
            return None
        if not isinstance(stamp, list):
            logger.warning("sources_event_skipped", "Malformed sources stamp on a tool result", tool_call_id=call_id)
            return None
        try:
            return self.emitter.sources(tool_call_id=call_id, sources=stamp)
        except ValidationError:
            logger.warning("sources_event_skipped", "Malformed sources stamp on a tool result",
                           tool_call_id=call_id, sources=len(stamp))
            return None

    def _on_tool_result(self, out: list[Event], msg: Any) -> None:
        call_id = getattr(msg, "tool_call_id", None)
        if not call_id:
            return
        error = getattr(msg, "status", None) == "error"
        name = getattr(msg, "name", None)
        if call_id in self._async_calls or name in (START_ASYNC_TASK_TOOL_NAME, UPDATE_ASYNC_TASK_TOOL_NAME):
            self._on_async_task_result(out, msg, str(call_id), name)
        elif call_id in self._silent_tools:
            self._silent_tools.discard(call_id)
        elif call_id in self._open_tools and call_id not in self._finished_tools:
            self._tool_card_close(out, call_id, msg, error=error)

    # --------------------------------------------------------- background tasks
    @staticmethod
    def _async_call(name: str, args: Mapping[str, Any]) -> dict[str, Any]:
        """What a start/update call's result event needs from its arguments."""
        if name == UPDATE_ASYNC_TASK_TOOL_NAME:
            return {"name": "", "description": str(args.get("message") or ""), "args": dict(args), "action": "update"}
        return {
            "name": str(args.get("subagent_type") or ""), "description": str(args.get("description") or ""),
            "args": dict(args), "action": "start",
        }

    def _on_async_task_result(self, out: list[Event], msg: Any, call_id: str, name: str | None) -> None:
        """TASK_LAUNCHED once per run; a launch without a task id is an errored tool card."""
        action = "update" if name == UPDATE_ASYNC_TASK_TOOL_NAME else "start"
        call = self._async_calls.pop(call_id, None)
        action = call["action"] if call else action
        call = call or self._async_call(START_ASYNC_TASK_TOOL_NAME, {})
        self._silent_tools.discard(call_id)
        if call_id in self._run.launched:
            return
        self._run.launched.add(call_id)
        error = getattr(msg, "status", None) == "error"
        match = None if error else _LAUNCHED_TASK_ID_RE.search(message_text(msg))
        if match:
            self._add(out, self.emitter.task_launched(
                task_id=match.group(1), name=call["name"], description=call["description"], action=action,
            ))
            return
        tool = UPDATE_ASYNC_TASK_TOOL_NAME if action == "update" else START_ASYNC_TASK_TOOL_NAME
        self._tool_card_open(out, call_id, tool, call["args"])
        self._tool_card_close(out, call_id, msg, error=True)

    def _on_interjection(self, out: list[Event], msg: Any) -> bool:
        """USER_INTERJECTION for a message the user sent while the run worked.

        ``SteeringMiddleware`` adds it to the state before a model call, marked
        with ``lc_source``; any other human message is not one. Returns whether
        ``msg`` was one, so it is never read as a task notification too.
        """
        kwargs = msg.get("additional_kwargs") if isinstance(msg, Mapping) else getattr(msg, "additional_kwargs", None)
        if not isinstance(kwargs, Mapping) or kwargs.get("lc_source") != INTERJECTION_SOURCE:
            return False
        content = msg.get("content") if isinstance(msg, Mapping) else getattr(msg, "content", None)
        text = content if isinstance(content, str) else message_text(msg)
        if not text:
            return True
        data = kwargs.get(INTERJECTION_DATA_KEY)
        queued_at = data.get("queued_at") if isinstance(data, Mapping) else None
        key = (text, queued_at if isinstance(queued_at, str) else None)
        if key in self._run.interjections:
            return True
        self._run.interjections.add(key)
        self._add(out, self.emitter.user_interjection(
            text=text, queued_at=queued_at if isinstance(queued_at, str) else None,
        ))
        return True

    def _on_task_notification(self, out: list[Event], msg: Any, node: Any, update: Mapping[str, Any]) -> None:
        """TASK_SETTLED_INLINE for a settled task's outcome pulled into the run.

        ``before_agent`` also re-labels the run's own input (a superseded
        wake-up): only an outcome the same update records at the event's run counts.
        """
        kwargs = msg.get("additional_kwargs") if isinstance(msg, Mapping) else getattr(msg, "additional_kwargs", None)
        if not isinstance(kwargs, Mapping):
            return
        event = kwargs.get(_NOTIFICATION_DATA_KEY) if kwargs.get("lc_source") == _NOTIFICATION_SOURCE else None
        if not isinstance(event, Mapping):
            event = kwargs.get(_NOTIFICATION_LEGACY_KEY)
        if not isinstance(event, Mapping):
            return
        status = _SETTLED_INLINE_STATUS.get(str(event.get("status") or ""))
        task_id, run_id = str(event.get("task_id") or ""), str(event.get("run_id") or "")
        if status is None or not task_id:
            return
        if isinstance(node, str) and node.endswith(".before_agent"):
            records = update.get("async_tasks")
            record = records.get(task_id) if isinstance(records, Mapping) else None
            if not isinstance(record, Mapping) or str(record.get("run_id") or "") != run_id:
                return
        if (task_id, run_id, status) in self._settled_inline:
            return
        self._settled_inline.add((task_id, run_id, status))
        self._add(out, self.emitter.task_settled_inline(
            task_id=task_id, name=str(event.get("agent_name") or ""), status=status,
        ))

    # ------------------------------------------------- plan, usage, compaction
    def _plan(self, out: list[Event], todos: list[Any], meta: dict[str, Any]) -> None:
        fingerprint = json.dumps(todos, ensure_ascii=False, sort_keys=True)
        if fingerprint != self._last_plan:
            self._last_plan = fingerprint
            self._add(out, self.emitter.plan_snapshot(todos, metadata=meta))

    def _usage(self, out: list[Event], msg: Any) -> None:
        """TOKEN_USAGE per settled model call, with the metrics stamped on it; and a
        compaction's result, from the reply that followed it."""
        usage = getattr(msg, "usage_metadata", None)
        response_metadata = getattr(msg, "response_metadata", None) or {}
        compaction = response_metadata.get(COMPACTION_KEY)
        if isinstance(compaction, dict):
            self._add(out, self._compaction_done(compaction, usage, response_metadata))
        if not (isinstance(usage, dict) and usage):
            return
        # Stamped on the reply by UsageMetricsMiddleware (a deep agent's custom
        # channel is not streamed, so the metrics ride the message).
        metrics = response_metadata.get(USAGE_METRICS_KEY)
        self._add(out, self.emitter.token_usage(
            usage, message_id=getattr(msg, "id", None), metrics=metrics if isinstance(metrics, dict) else None,
        ))

    def _on_summary_call(self, msg: Any) -> list[Event]:
        """A compaction's summary call: that it started and its cost (once)."""
        out: list[Event] = []
        if not self._compaction_open:
            self._compaction_open = True
            self._compactions += 1
            self._add(out, self.emitter.context_compaction("started"))
        usage = getattr(msg, "usage_metadata", None)
        if isinstance(usage, dict) and usage:
            call_id = getattr(msg, "id", None) or f"compaction-{self.thread_id}-{self._compactions}"
            if call_id not in self._compaction_usage_ids:
                self._compaction_usage_ids.add(call_id)
                self._add(out, self.emitter.token_usage(usage, message_id=call_id, purpose="compaction"))
        return out

    def _compaction_done(self, stamp: dict[str, Any], usage: Any, response_metadata: dict[str, Any]) -> Event:
        """The reply's prompt is the context after; the summarizer's estimate of what it freed gives before."""
        self._compaction_open = False
        after = usage.get("input_tokens") if isinstance(usage, dict) else None
        after = after if isinstance(after, int) else None
        freed = stamp.get("freed") if isinstance(stamp.get("freed"), int) else None
        metrics = response_metadata.get(USAGE_METRICS_KEY)
        window = metrics.get("context_window") if isinstance(metrics, dict) else None
        return self.emitter.context_compaction("done", details={
            "tokens_after": after,
            "freed": freed,
            "tokens_before": after + freed if after is not None and freed is not None else None,
            "window": window if isinstance(window, int) else None,
            "summarized_messages": stamp.get("summarized_messages"),
            "kept_messages": stamp.get("kept_messages"),
        })

    @staticmethod
    def _add(out: list[Event], event: Event) -> None:
        out.append(event)

