"""The in-memory state of one live run: content, thoughts, tool calls and token
usage folded from the agents service's SSE events, plus the coalescing of
streamed deltas into the persisted event log.
"""

import time
from copy import deepcopy
from typing import Any
from core.settings import settings
from core.logging import get_logger
from utils.pricing import call_cost_micros

logger = get_logger(__name__)


def _as_int(value: Any) -> int:
    """A token or millisecond count from an event, or 0 for anything else."""
    return int(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else 0


def _detail_sum(details: Any, kind: str) -> int:
    """Sum a usage detail across provider variants: OpenAI reports
    ``cache_read`` / ``reasoning`` and, on a service tier, prefixed copies
    such as ``flex_cache_read`` — the same tokens, never both at once."""
    if not isinstance(details, dict):
        return 0
    return sum(_as_int(v) for k, v in details.items() if str(k) == kind or str(k).endswith(f"_{kind}"))


# Plan 41: cost, truncation and speed, derived per settled call — run totals,
# and columns of the same name on message_usage and usage_daily_groups.
_GROUP_METRICS = (
    "cost_micros", "unpriced_calls", "truncated_calls", "ttft_ms", "ttft_calls", "gen_ms", "gen_output_tokens",
)


# The run totals summed from TOKEN_USAGE (each also a per-group counter).
_USAGE_TOTALS = (
    "input_tokens", "output_tokens", "cached_input_tokens", "reasoning_tokens", "model_latency_ms",
    *_GROUP_METRICS,
)


def _call_metrics(value: dict[str, Any], input_tokens: int, cached: int, output_tokens: int) -> dict[str, int]:
    """Plan 41's derivations for one settled model call.

    * cost from ``utils/pricing.py``; a model with no price (or no model
      reported at all) is one unpriced call and adds no cost;
    * truncated when the agents service says the call hit the output limit;
    * speed only for a call that streamed (it reports ``ttft_ms``): its time to
      first token, the time after it, and the output tokens of that time — so
      tokens per second never mixes in a call that delivered everything at once.
    """
    cost = call_cost_micros(value.get("model"), input_tokens, cached, output_tokens)
    ttft = value.get("ttft_ms")
    streamed = isinstance(ttft, (int, float)) and not isinstance(ttft, bool) and ttft >= 0
    ttft_ms = int(ttft) if streamed else 0
    return {
        "cost_micros": cost or 0,
        "unpriced_calls": 1 if cost is None else 0,
        "truncated_calls": 1 if value.get("truncated") is True else 0,
        "ttft_ms": ttft_ms,
        "ttft_calls": 1 if streamed else 0,
        "gen_ms": max(_as_int(value.get("latency_ms")) - ttft_ms, 0) if streamed else 0,
        "gen_output_tokens": output_tokens if streamed else 0,
    }


def _add_to_groups(groups: dict[Any, dict[str, int]], key: Any, contribution: dict[str, int], sign: int) -> None:
    """Add (or, with ``sign=-1``, take back) one call's contribution to its group."""
    group = groups.setdefault(key, dict.fromkeys(contribution, 0))
    for field, amount in contribution.items():
        group[field] += sign * amount
    if not any(group.values()):
        del groups[key]


_TEXT_DELTA_TYPES = {"TEXT_MESSAGE_CHUNK", "TEXT_MESSAGE_CONTENT"}


def _coalesce_key(event: dict[str, Any]) -> tuple[Any, ...] | None:
    """Merge identity for delta-bearing events. Consecutive stored events with
    the same key are collapsed into one event with a concatenated ``delta`` so
    the persisted log stays block-lossless without keeping per-token entries.

    THINKING_TEXT_MESSAGE_CONTENT pieces merge too: a thought now streams as
    START, CONTENT pieces, END, so consecutive CONTENT events are always one
    thought's pieces — every emitter brackets each thought with START / END,
    which sit between two thoughts and keep them apart.
    """
    event_type = event.get("type")
    if event_type in _TEXT_DELTA_TYPES:
        return ("text", event.get("messageId"), repr(event.get("namespace")))
    if event_type == "THINKING_TEXT_MESSAGE_CONTENT":
        return ("thought", repr(event.get("namespace")))
    if event_type == "TOOL_CALL_ARGS":
        return ("tool_args", event.get("toolCallId"))
    return None


def _merge_delta_into(last: dict[str, Any], incoming: dict[str, Any]) -> bool:
    key = _coalesce_key(incoming)
    if key is None or key != _coalesce_key(last):
        return False
    last["delta"] = str(last.get("delta") or "") + str(incoming.get("delta") or "")
    if incoming.get("timestamp") is not None:
        last["timestampEnd"] = incoming["timestamp"]
    return True


def truncate_tool_result(event: dict[str, Any]) -> dict[str, Any]:
    """Cap an oversized tool result, live and stored.

    Image results are exempt: the agents service already replaced the original
    with a bounded thumbnail, and cutting a base64 string mid-way only makes it
    undecodable — which is exactly what used to reach the UI.
    """
    content = event.get("content")
    if not isinstance(content, str):
        return event
    limit = settings.inference.tool_result_max_chars
    if len(content) <= limit or "preview_base64" in content:
        return event
    return {**event, "content": content[:limit], "truncated": True}


def append_coalesced(log: list[dict[str, Any]], event: dict[str, Any]) -> None:
    """Append ``event`` to a stored AG-UI event log, merging consecutive deltas.

    The one coalescing rule for every durable event log: a run's
    ``messages.raw_events`` and a background task's
    ``conversation_tasks.raw_events`` (plan 41) — so a task's drill-down
    hydrates exactly like a run's timeline. Text and tool-argument deltas of
    the same message / call collapse into one event (``timestampEnd`` keeps the
    last one's time); ``SUBAGENT_EVENT`` envelopes merge one level down, on the
    same ``task_id``. A copy is stored, never the caller's dict.
    """
    stored = deepcopy(event)
    if log:
        last = log[-1]
        if _merge_delta_into(last, stored):
            last["seq"] = stored.get("seq", last.get("seq"))
            return
        # SUBAGENT_EVENT envelopes wrap the inner delta, so the merge has
        # to happen one level down: same task_id + mergeable inner events.
        if (
            last.get("type") == "CUSTOM"
            and stored.get("type") == "CUSTOM"
            and last.get("name") == "SUBAGENT_EVENT"
            and stored.get("name") == "SUBAGENT_EVENT"
        ):
            last_value, stored_value = last.get("value"), stored.get("value")
            if (
                isinstance(last_value, dict)
                and isinstance(stored_value, dict)
                and last_value.get("task_id") == stored_value.get("task_id")
                and isinstance(last_value.get("event"), dict)
                and isinstance(stored_value.get("event"), dict)
                and _merge_delta_into(last_value["event"], stored_value["event"])
            ):
                last["seq"] = stored.get("seq", last.get("seq"))
                if stored.get("timestamp") is not None:
                    last["timestampEnd"] = stored["timestamp"]
                return
    log.append(stored)


class InferenceRunRuntime:
    def __init__(self) -> None:
        self.content = ""
        self.thoughts: list[str] = []
        # A thought is streaming (its START seen, END not yet): its pieces
        # extend the last entry of ``thoughts`` instead of each adding one.
        self._thought_streaming = False
        self.raw_events: list[dict[str, Any]] = []
        self.first_event_ts = 0.0
        self.thinking_start = 0.0
        self.thinking_end = 0.0
        self.closed_thinking_on_first_chunk = False
        self.next_seq = 0
        # Outstanding HITL interrupt identities emitted by the agent but not
        # yet resumed. Used by `InferenceRunManager._run` to decide whether to
        # wait for a /resume after the upstream stream ends, rather than
        # finalising the run as completed. Tracked by `interrupt.id`, never a
        # bare counter: a sub-agent interrupt is delivered TWICE (top-level
        # HITL_INTERRUPT with namespace metadata + the same event wrapped in
        # SUBAGENT_EVENT) while each /resume resolves exactly one interrupt —
        # a counter drifts upward and the run never finalises.
        self.pending_interrupt_ids: list[str] = []
        # Per-run token usage, summed across every AI message (main + sub-agents,
        # across all resume legs). Deduped by message_id since a settled AI
        # message can surface both directly and wrapped in a SUBAGENT_EVENT.
        self.input_tokens = 0
        self.output_tokens = 0
        self.cached_input_tokens = 0
        self.reasoning_tokens = 0
        self.model_latency_ms = 0
        # Plan 41, summed the same way: cost in micro-USD and calls on a model
        # with no price; calls cut off at the output limit; and, over the calls
        # that streamed, time to first token, generation time after it and the
        # output tokens of that time (see _call_metrics).
        self.cost_micros = 0
        self.unpriced_calls = 0
        self.truncated_calls = 0
        self.ttft_ms = 0
        self.ttft_calls = 0
        self.gen_ms = 0
        self.gen_output_tokens = 0
        # The answer's time to first text (plan 41): from the moment this run
        # started — the runtime is created as the run's task begins — to the
        # main agent's first text delta, measured here because only the bridge
        # sees the whole run (queueing, attachment seeding, every model call
        # and tool before the text). Monotonic clock. Settled once: by the
        # first text, or by a HITL interrupt before it, in which case it stays
        # None — the wait was the human's, not the model's.
        self.started_at = time.perf_counter()
        self.first_token_ms: int | None = None
        self._first_token_settled = False
        # The same usage split by who spent it — (scope, agent, model) → sums —
        # for the message_usage rows (plan 33). Scope is "main" or "subagent";
        # the main agent's label is filled in at finish (the runtime does not
        # know it). Each counted call remembers its group, so a call first seen
        # bare and then wrapped in SUBAGENT_EVENT moves to its sub-agent.
        self.usage_groups: dict[tuple[str, str, str | None], dict[str, int]] = {}
        self._usage_by_call: dict[str, tuple[tuple[str, str, str | None], dict[str, int]]] = {}
        # Tool calls from TOOL_USAGE (plan 41), the same way: (scope, agent,
        # tool) → calls / errors / duration_ms / output_chars, each call counted
        # once by its tool_call_id and moved to its sub-agent when it turns up
        # wrapped after being seen bare.
        self.tool_groups: dict[tuple[str, str, str], dict[str, int]] = {}
        self._tool_by_call: dict[str, tuple[tuple[str, str, str], dict[str, int]]] = {}
        # task_id → sub-agent type, from TASK_SUBAGENT, so a wrapped call is
        # booked to "researcher" rather than to an anonymous sub-agent.
        self._subagent_types: dict[str, str] = {}
        # The main agent's context on its most recent model call — prompt size,
        # the model's window, where it compacts, which model (sub-agents run
        # their own, separate contexts, so they never overwrite this).
        self.context: dict[str, Any] = {}
        # The durable checkpoint head the agent committed this run (captured
        # from the terminal CHECKPOINT_COMMITTED event). Persisted on the AI
        # message by _finish_run so the next turn resumes / forks from it.
        self.produced_checkpoint_id: str | None = None
        # Deliverables the agent designated via present_artifact (captured from
        # PRESENT_ARTIFACT custom events). Each entry is
        # {artifact_id, path, title, summary}; deduped by path (last wins). At
        # finalize _finish_run reads these files back from the agents service and
        # persists them as generated attachments on the assistant message.
        self.presented_artifacts: list[dict[str, Any]] = []

    def _usage_group(self, value: dict[str, Any], *, main_agent: bool, task_id: Any) -> tuple[str, str, str | None]:
        """Who spent a call: ("main" | "subagent" | "compaction", name, model).

        The summary call of the main agent's automatic compaction (plan 34) is
        its own group, so Usage can say what compaction costs.
        """
        model = str(value["model"])[:200] if value.get("model") else None
        if main_agent and value.get("purpose") == "compaction":
            return ("compaction", "Compaction", model)
        if main_agent:
            return ("main", "", model)
        return ("subagent", self._subagent_label(task_id), model)

    def _register_subagent_type(self, value: Any) -> None:
        """Remember a TASK_SUBAGENT's type under its `task` call id."""
        if isinstance(value, dict) and value.get("task_id") and value.get("subagent_type"):
            self._subagent_types[str(value["task_id"])] = str(value["subagent_type"])[:200]

    def _subagent_label(self, task_id: Any) -> str:
        subagent_type = self._subagent_types.get(str(task_id)) if task_id is not None else None
        return subagent_type or "sub-agent"

    def _add_to_group(self, key: tuple[str, str, str | None], contribution: dict[str, int], sign: int) -> None:
        _add_to_groups(self.usage_groups, key, contribution, sign)

    @staticmethod
    def _book_once(
        by_call: dict[str, tuple[Any, dict[str, int]]],
        groups: dict[Any, dict[str, int]],
        token: str,
        key: Any,
    ) -> bool:
        """True when ``token`` was already counted. A call booked to the main
        agent that now turns out to be a sub-agent's is moved — every field of
        its contribution, so no total ever counts it twice or loses it."""
        counted = by_call.get(token)
        if counted is None:
            return False
        previous_key, contribution = counted
        if previous_key[0] == "main" and key[0] == "subagent":
            _add_to_groups(groups, previous_key, contribution, -1)
            _add_to_groups(groups, key, contribution, 1)
            by_call[token] = (key, contribution)
        return True

    def _accumulate_usage(self, value: Any, *, main_agent: bool, task_id: Any = None) -> None:
        """Fold one TOKEN_USAGE event into the run's totals (deduped by message)."""
        if not isinstance(value, dict):
            return
        mid = value.get("message_id")
        token = str(mid) if mid is not None else f"usage-{self.next_seq}"
        key = self._usage_group(value, main_agent=main_agent, task_id=task_id)
        if self._book_once(self._usage_by_call, self.usage_groups, token, key):
            return
        input_tokens = _as_int(value.get("input_tokens"))
        cached = _detail_sum(value.get("input_token_details"), "cache_read")
        output_tokens = _as_int(value.get("output_tokens"))
        contribution = {
            "calls": 1,
            "input_tokens": input_tokens,
            "cached_input_tokens": cached,
            "output_tokens": output_tokens,
            "reasoning_tokens": _detail_sum(value.get("output_token_details"), "reasoning"),
            "model_latency_ms": _as_int(value.get("latency_ms")),
            **_call_metrics(value, input_tokens, cached, output_tokens),
        }
        self._usage_by_call[token] = (key, contribution)
        self._add_to_group(key, contribution, 1)
        for field in _USAGE_TOTALS:
            setattr(self, field, getattr(self, field) + contribution[field])
        if main_agent and isinstance(value.get("context_tokens"), int):
            self.context = {
                "context_tokens": value.get("context_tokens"),
                "context_window": value.get("context_window") if isinstance(value.get("context_window"), int) else None,
                "compaction_percent": value.get("compaction_percent")
                if isinstance(value.get("compaction_percent"), (int, float)) else None,
                "model_name": str(value["model"])[:200] if value.get("model") else None,
            }

    def _accumulate_tool_usage(self, value: Any, *, main_agent: bool, task_id: Any = None) -> None:
        """Fold one TOOL_USAGE event into the tool groups (plan 41).

        Deduped by ``tool_call_id`` and grouped by (scope, agent, tool) exactly
        like token usage — a call first seen bare and then wrapped in
        SUBAGENT_EVENT moves to its sub-agent. Metrics only: the event never
        carries arguments or output, and nothing here would keep them.
        """
        if not isinstance(value, dict):
            return
        call_id = value.get("tool_call_id")
        token = str(call_id) if call_id is not None else f"tool-{self.next_seq}"
        tool_name = str(value.get("tool_name") or "")[:200] or "unknown tool"
        key = ("main", "", tool_name) if main_agent else ("subagent", self._subagent_label(task_id), tool_name)
        if self._book_once(self._tool_by_call, self.tool_groups, token, key):
            return
        contribution = {
            "calls": 1,
            "errors": 1 if value.get("status") == "error" else 0,
            "duration_ms": _as_int(value.get("duration_ms")),
            "output_chars": _as_int(value.get("output_chars")),
        }
        self._tool_by_call[token] = (key, contribution)
        _add_to_groups(self.tool_groups, key, contribution, 1)

    def _note_first_text(self, delta: Any) -> None:
        """Settle the answer's time to first text on its first non-empty delta."""
        if self._first_token_settled or not delta:
            return
        self._first_token_settled = True
        self.first_token_ms = max(0, round((time.perf_counter() - self.started_at) * 1000))

    @property
    def pending_interrupts(self) -> int:
        return len(self.pending_interrupt_ids)

    def register_interrupt(self, value: Any) -> None:
        # An approval before the first text makes the wait the human's: the
        # answer's time to first text is then left unmeasured (None).
        self._first_token_settled = True
        wrapped = value.get("interrupt") if isinstance(value, dict) else None
        raw_id = wrapped.get("id") if isinstance(wrapped, dict) else None
        token = str(raw_id) if raw_id is not None else f"anon-{self.next_seq}"
        if token not in self.pending_interrupt_ids:
            self.pending_interrupt_ids.append(token)

    def _register_presented_artifact(self, value: Any) -> None:
        """Record a PRESENT_ARTIFACT event's metadata, deduped by path.

        Only top-level (orchestrator) present calls reach here — a sub-agent's
        is never emitted as a top-level PRESENT_ARTIFACT (see the agents-service
        normalizer). Re-presenting the same path overwrites the earlier entry so
        the finalize fetch reads the file's latest bytes once."""
        if not isinstance(value, dict):
            return
        path = value.get("path")
        if not path:
            return
        entry = {
            "artifact_id": value.get("artifact_id"),
            "path": str(path),
            "title": value.get("title") or "",
            "summary": value.get("summary"),
        }
        self.presented_artifacts = [
            a for a in self.presented_artifacts if a["path"] != entry["path"]
        ]
        self.presented_artifacts.append(entry)

    def resolve_interrupt(self, interrupt_id: Any) -> None:
        token = str(interrupt_id) if interrupt_id is not None else None
        if token and token in self.pending_interrupt_ids:
            self.pending_interrupt_ids.remove(token)
        elif self.pending_interrupt_ids:
            self.pending_interrupt_ids.pop(0)

    def thinking_duration_seconds(self) -> int | None:
        if not (self.thinking_start or self.first_event_ts):
            return None
        start = self.first_event_ts or self.thinking_start
        end = self.thinking_end or time.perf_counter()
        return max(0, round(end - start))

    def _append_raw(self, event: dict[str, Any]) -> None:
        append_coalesced(self.raw_events, event)

    def apply_event(self, event: dict[str, Any]) -> dict[str, Any] | None:
        """Fold one upstream AG-UI event into the run state and return the
        seq-stamped wire event for the delta frame, or ``None`` for events that
        are captured internally but must not be persisted/streamed (e.g.
        CHECKPOINT_COMMITTED).

        Every event lands in ``raw_events`` (the durable per-run log the UI
        replays into its timeline); consecutive delta events are coalesced on
        append. Aggregates (``content``/``thoughts``) are kept only for
        previews, search, voice read-aloud and export.
        """
        event_type = event.get("type")
        if not self.first_event_ts:
            self.first_event_ts = time.perf_counter()
        self.next_seq += 1

        if event_type == "TOOL_CALL_RESULT":
            event = truncate_tool_result(event)
        elif event_type == "CUSTOM" and event.get("name") == "SUBAGENT_EVENT":
            value = event.get("value")
            if isinstance(value, dict):
                inner = value.get("event")
                if isinstance(inner, dict) and inner.get("type") == "TOOL_CALL_RESULT":
                    truncated = truncate_tool_result(inner)
                    if truncated is not inner:
                        event = {**event, "value": {**value, "event": truncated}}
        event = {**event, "seq": self.next_seq}

        if event_type == "CUSTOM":
            name = event.get("name")
            value = event.get("value")
            if name == "SUBAGENT_EVENT":
                # A subagent that emits __interrupt__ surfaces BOTH as a
                # top-level HITL_INTERRUPT (namespace in metadata) and as
                # SUBAGENT_EVENT(value={..., event: CUSTOM HITL_INTERRUPT}).
                # register_interrupt dedupes by interrupt.id, so whichever
                # envelope arrives second is a no-op and one approval resolves
                # the whole identity.
                if isinstance(value, dict):
                    inner = value.get("event")
                    if isinstance(inner, dict) and inner.get("type") == "CUSTOM":
                        inner_name = inner.get("name")
                        if inner_name == "HITL_INTERRUPT":
                            self.register_interrupt(inner.get("value"))
                        elif inner_name == "TOKEN_USAGE":
                            self._accumulate_usage(
                                inner.get("value"), main_agent=False, task_id=value.get("task_id")
                            )
                        elif inner_name == "TOOL_USAGE":
                            self._accumulate_tool_usage(
                                inner.get("value"), main_agent=False, task_id=value.get("task_id")
                            )
                        elif inner_name == "TASK_SUBAGENT":
                            # A sub-agent that delegates in turn: its `task` call
                            # arrives inside its own envelope, while the nested
                            # sub-agent's usage arrives under that call's id.
                            self._register_subagent_type(inner.get("value"))
            elif name == "HITL_INTERRUPT":
                self.register_interrupt(value)
            elif name == "TOKEN_USAGE":
                self._accumulate_usage(value, main_agent=True)
            elif name == "TOOL_USAGE":
                self._accumulate_tool_usage(value, main_agent=True)
            elif name == "TASK_SUBAGENT":
                self._register_subagent_type(value)
            elif name == "PRESENT_ARTIFACT":
                # Capture the deliverable for the finalize fetch, but let the
                # event flow into raw_events unchanged — the UI renders it as a
                # live artifact card (Phase 2) and it must survive reconnection.
                self._register_presented_artifact(value)
            elif name == "CHECKPOINT_COMMITTED":
                # Internal bridge<->agent metadata: capture the durable head but
                # do NOT persist it into raw_events (it is not a render event,
                # and it would carry the internal thread/checkpoint uuids into
                # share snapshots + conversation clones). Suppressed from the
                # wire and the durable log by returning None below.
                if isinstance(value, dict):
                    committed = value.get("checkpoint_id")
                    if committed:
                        self.produced_checkpoint_id = str(committed)
                return None
        elif event_type == "THINKING_START":
            self.thinking_start = time.perf_counter()
            self.thinking_end = 0.0
        elif event_type == "THINKING_TEXT_MESSAGE_START":
            self.thoughts.append("")
            self._thought_streaming = True
        elif event_type == "THINKING_TEXT_MESSAGE_CONTENT":
            delta = str(event.get("delta") or "")
            if self._thought_streaming and self.thoughts:
                self.thoughts[-1] += delta
            else:
                self.thoughts.append(delta)
        elif event_type == "THINKING_TEXT_MESSAGE_END":
            self._thought_streaming = False
            if self.thoughts and not self.thoughts[-1].strip():
                self.thoughts.pop()
        elif event_type == "TOOL_CALL_START":
            self._thought_streaming = False
            self.thoughts.append(f"[tool] {event.get('toolCallName') or 'tool'}")
        elif event_type == "THINKING_END":
            self.thinking_end = time.perf_counter()
        elif event_type == "TEXT_MESSAGE_START":
            # Each model call's text is its own paragraph (a progress update,
            # then the answer): joined without a break they ran together as
            # "…sources.The first searches…" in Copy and the PDF.
            if self.content.strip():
                self.content = self.content.rstrip() + "\n\n"
        elif event_type in _TEXT_DELTA_TYPES:
            self.content += str(event.get("delta") or "")
            # Top-level text is the main agent's (a sub-agent's arrives wrapped
            # in SUBAGENT_EVENT), so this is the answer's first token.
            self._note_first_text(event.get("delta"))
            if not self.closed_thinking_on_first_chunk:
                self.closed_thinking_on_first_chunk = True
                self.thinking_end = time.perf_counter()

        self._append_raw(event)
        return event
