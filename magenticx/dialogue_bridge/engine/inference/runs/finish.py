"""Ending a run: persist the answer and its usage breakdown in one transaction,
then call the run-finished hooks (the composer queue, task wake-ups).
"""

from copy import deepcopy
from typing import Any, Awaitable, Callable
from sqlalchemy.ext.asyncio import AsyncSession
from core.database import (
    ConversationTable,
    MessageTable,
    MessageUsageTable,
    SessionLocal,
    ToolUsageTable,
)
from core.logging import get_logger
from engine.conversations.conversations import _preview
from engine.inference.output_capture import capture_canvas_documents, capture_presented_files
from engine.inference.activity import RunActivity, count_run_activity
from engine.account.usage_rollups import add_answer_to_rollups
from engine.inference.runs.state import TERMINAL_RUN_STATUSES, _now
from engine.inference.runs.runtime import InferenceRunRuntime, _GROUP_METRICS
from engine.inference.runs.payloads import _load_run

logger = get_logger(__name__)


def _message_payload_from_runtime(runtime: "InferenceRunRuntime", *, error: bool, error_message: str | None) -> dict[str, Any]:
    return {
        "content": runtime.content or "",
        "reasoning_steps": deepcopy(runtime.thoughts) or None,
        "reasoning_time_seconds": runtime.thinking_duration_seconds(),
        "is_error": error,
        "error_message": error_message,
        "raw_events": deepcopy(runtime.raw_events) or [],
    }


#: What runs after a run has ended and its terminal frame is out. Registered
#: by the features that react to a run ending (plan 41: the composer's queued
#: message and the background-task wake-up safety net, engine/inference/tasks/wakeups.py)
#: — a registry rather than an import, because those modules start runs
#: through this one.
RunFinishedHook = Callable[[str, Callable[[], AsyncSession]], Awaitable[None]]


_run_finished_hooks: list[RunFinishedHook] = []


def register_run_finished_hook(hook: RunFinishedHook) -> None:
    """Call ``hook(run_id, session_factory)`` after every run's terminal frame.

    ``session_factory`` is this module's ``SessionLocal`` as it is at call
    time, so the hook reads the database the run was written to. A hook must
    not raise; one that does is logged and the others still run.
    """
    if hook not in _run_finished_hooks:
        _run_finished_hooks.append(hook)


async def _run_finished(run_id: str) -> None:
    for hook in list(_run_finished_hooks):
        try:
            await hook(run_id, SessionLocal)
        except Exception:
            logger.error("run_finished_hook_failed", "A run-finished hook failed", exc_info=True, run_id=run_id)


async def _record_usage_breakdown(
    db: AsyncSession,
    run: MessageTable,
    conversation: ConversationTable,
    runtime: InferenceRunRuntime,
    activity: RunActivity,
) -> None:
    """Book a finished answer's usage for the Usage tab (plan 33).

    Writes one ``message_usage`` row per (scope, agent, model) group and one
    ``tool_usage`` row per (scope, agent, tool) (plan 41), adds the answer to
    its conversation's running totals, and adds it to the user's daily rollups
    (``tool_usage_daily`` included) — all in the caller's transaction, so the
    answer and every figure derived from it land together or not at all. Totals are SQL
    expressions (``col = col + n``), so runs finishing concurrently can never
    lose each other's update.
    """
    created_at = run.created_at or _now()
    main_label = run.agent_name or "Agent"
    for (scope, agent_name, model_name), group in runtime.usage_groups.items():
        db.add(
            MessageUsageTable(
                message_id=run.id,
                conversation_id=run.conversation_id,
                user_id=conversation.user_id,
                agent_id=run.agent_id,
                main_agent_name=run.agent_name,
                scope=scope,
                agent_name=main_label if scope == "main" else agent_name,
                model_name=model_name,
                created_at=created_at,
                **group,
            )
        )
    # What the answer's tools took (plan 41), split the same way.
    for (scope, agent_name, tool_name), group in runtime.tool_groups.items():
        db.add(
            ToolUsageTable(
                message_id=run.id,
                conversation_id=run.conversation_id,
                user_id=conversation.user_id,
                agent_id=run.agent_id,
                main_agent_name=run.agent_name,
                scope=scope,
                agent_name=main_label if scope == "main" else agent_name,
                tool_name=tool_name,
                created_at=created_at,
                **group,
            )
        )
    # The day's tool rollup keys on the main agent and the tool alone: a
    # sub-agent's calls of a tool count under the agent that delegated them.
    tools_by_name: dict[str, dict[str, int]] = {}
    for (_scope, _agent, tool_name), group in runtime.tool_groups.items():
        total = tools_by_name.setdefault(tool_name, dict.fromkeys(group, 0))
        for field, amount in group.items():
            total[field] += amount

    table = ConversationTable
    conversation.usage_answers = table.usage_answers + 1
    conversation.usage_input_tokens = table.usage_input_tokens + runtime.input_tokens
    conversation.usage_cached_tokens = table.usage_cached_tokens + runtime.cached_input_tokens
    conversation.usage_output_tokens = table.usage_output_tokens + runtime.output_tokens
    conversation.usage_total_tokens = table.usage_total_tokens + runtime.input_tokens + runtime.output_tokens
    conversation.usage_model_calls = table.usage_model_calls + activity.model_calls
    conversation.usage_tool_calls = table.usage_tool_calls + activity.tool_calls
    conversation.usage_model_ms = table.usage_model_ms + runtime.model_latency_ms
    conversation.usage_cost_micros = table.usage_cost_micros + runtime.cost_micros
    conversation.usage_truncated_calls = table.usage_truncated_calls + runtime.truncated_calls
    if runtime.context.get("context_tokens") is not None:
        conversation.last_context_tokens = runtime.context["context_tokens"]
        conversation.last_context_window = runtime.context.get("context_window")
    conversation.usage_updated_at = _now()

    await add_answer_to_rollups(
        db,
        user_id=conversation.user_id,
        day=created_at.date(),
        agent_id=run.agent_id,
        agent_name=run.agent_name,
        answer={
            "answers": 1,
            "input_tokens": runtime.input_tokens,
            "cached_input_tokens": runtime.cached_input_tokens,
            "output_tokens": runtime.output_tokens,
            "reasoning_tokens": runtime.reasoning_tokens,
            "model_ms": runtime.model_latency_ms,
            "model_calls": activity.model_calls,
            "tool_calls": activity.tool_calls,
            # Every answer finished from here on records calls and model time.
            "detailed_answers": 1,
            "detailed_input_tokens": runtime.input_tokens,
            "cost_micros": runtime.cost_micros,
            "unpriced_calls": runtime.unpriced_calls,
            "truncated_calls": runtime.truncated_calls,
            # Added only when measured: first_token_answers is the average's
            # denominator, so an unmeasured answer never drags it down.
            "first_token_ms": runtime.first_token_ms or 0,
            "first_token_answers": 1 if runtime.first_token_ms is not None else 0,
        },
        groups=[
            {
                "scope": scope,
                "group_name": main_label if scope == "main" else agent_name,
                "model_name": model_name or "",
                "calls": group["calls"],
                "input_tokens": group["input_tokens"],
                "cached_input_tokens": group["cached_input_tokens"],
                "output_tokens": group["output_tokens"],
                "reasoning_tokens": group["reasoning_tokens"],
                "model_ms": group["model_latency_ms"],
                **{field: group[field] for field in _GROUP_METRICS},
            }
            for (scope, agent_name, model_name), group in runtime.usage_groups.items()
        ],
        tools=[{"tool_name": name, **counters} for name, counters in tools_by_name.items()],
    )


async def _finish_run(run_id: str, runtime: InferenceRunRuntime, status_value: str, error_message: str | None = None) -> None:
    async with SessionLocal() as db:
        run = await _load_run(db, run_id)
        if not run:
            return
        if run.streaming_status in TERMINAL_RUN_STATUSES:
            return
        # If a cancel was requested mid-flight, normalize a "completed" verdict
        # to "cancelled" so the user-visible outcome matches their intent.
        if status_value == "completed" and (
            run.streaming_status == "cancelling" or run.streaming_cancel_requested_at is not None
        ):
            status_value = "cancelled"
            error_message = None

        is_error = status_value == "failed"
        payload = _message_payload_from_runtime(runtime, error=is_error, error_message=error_message)

        # Write streaming metadata + final content onto the single MessageTable row.
        run.streaming_status = status_value
        run.streaming_completed_at = _now()
        run.content = payload["content"] or (
            "An error occurred while generating the response." if is_error else ""
        )
        run.reasoning_steps = payload["reasoning_steps"]
        run.reasoning_time_seconds = payload["reasoning_time_seconds"]
        run.raw_events = payload["raw_events"]
        run.input_tokens = runtime.input_tokens or None
        run.output_tokens = runtime.output_tokens or None
        run.cached_input_tokens = runtime.cached_input_tokens or None
        run.reasoning_tokens = runtime.reasoning_tokens or None
        run.model_latency_ms = runtime.model_latency_ms or None
        run.context_tokens = runtime.context.get("context_tokens")
        run.context_window = runtime.context.get("context_window")
        run.compaction_percent = runtime.context.get("compaction_percent")
        run.model_name = runtime.context.get("model_name")
        # Only an answer that spent tokens has work to count; one that failed
        # before its first model call stays NULL, like its token columns.
        has_usage = bool(runtime.input_tokens or runtime.output_tokens)
        activity = count_run_activity(payload["raw_events"])
        run.model_calls = activity.model_calls if has_usage else None
        run.tool_calls = activity.tool_calls if has_usage else None
        # Plan 41's figures, NULL like the counts above on an answer that spent
        # nothing. On one that did, a 0 is a measurement (no call was cut off).
        for field in _GROUP_METRICS:
            setattr(run, field, getattr(runtime, field) if has_usage else None)
        # Measured by the bridge from the text it saw, so kept whenever there was
        # text — None when there was none, or when a HITL approval came first.
        run.first_token_ms = runtime.first_token_ms
        run.is_error = is_error
        run.error_message = error_message
        # Advance the branch head so the next turn resumes / forks from the
        # state this run committed. Only overwrite when the agent actually
        # reported a head (keep any prior value otherwise).
        if runtime.produced_checkpoint_id:
            run.checkpoint_id = runtime.produced_checkpoint_id
        run.updated_at = _now()

        conversation = await db.get(ConversationTable, run.conversation_id)
        if conversation:
            if conversation.active_assistant_message_id == run.id:
                conversation.active_assistant_message_id = None
            preview = _preview(run.content)
            if preview:
                conversation.last_message_preview = preview
            conversation.last_message_at = _now()
            conversation.updated_at = _now()
            if has_usage:
                await _record_usage_breakdown(db, run, conversation, runtime, activity)

        # The files the agent presented this run, in this transaction: their
        # cards must find them when the terminal frame reaches the UI.
        await capture_presented_files(db, run, conversation, runtime.presented_artifacts)
        # The canvas documents (plan 44) the run presented or changed, as the
        # agent's versions, and what the agent has now seen (4.3); fail-open.
        await capture_canvas_documents(db, run, conversation, runtime.presented_artifacts)

        await db.commit()


async def _mark_run_completed(run_id: str, runtime: InferenceRunRuntime) -> None:
    await _finish_run(run_id, runtime, "completed")


async def _mark_run_cancelled(run_id: str, runtime: InferenceRunRuntime) -> None:
    await _finish_run(run_id, runtime, "cancelled")


async def _mark_run_failed(run_id: str, runtime: InferenceRunRuntime, error_message: str) -> None:
    await _finish_run(run_id, runtime, "failed", error_message)


async def mark_run_launch_failed(run_id: str) -> None:
    await _finish_run(run_id, InferenceRunRuntime(), "failed", "Inference run could not be launched.")
