"""The run manager: one asyncio task per live run that streams from the agents
service, publishes frames to the event log, handles resume and cancel, and
finishes the run.
"""

import asyncio
import time
from copy import deepcopy
from typing import Any
import httpx
from sqlalchemy import select
from core.database import (
    ConversationTable,
    MessageTable,
    SessionLocal,
    UserPreferencesTable,
)
from core.security.internal_trust import internal_service_headers
from core.settings import settings
from engine.agents import tool_prefs as agent_tool_prefs
from core.security.tls import get_httpx_client_cert, get_httpx_verify
from core.logging import get_context, get_logger
from engine.agents.service_urls import build_agent_resume_url, build_agent_stream_url
from engine.agents.catalog import get_agent_by_id
from engine.documents.canvas_edit import canvas_edit_context
from engine.agents.commands import command_context
from engine.inference.effort import effort_context
from engine.inference.event_log import event_log
from engine.inference.hitl import (
    EXPIRED_DECISION,
    EXPIRED_REASON,
    HitlDecisionQueue,
    ResumeOutcome,
    StaleDecisions,
    stale_decisions_from_conflict,
)
from engine.inference.history import (
    answers_up_to,
    nearest_committed_ai,
    prepare_inference_history,
    serialise_message_with_images_for_agent,
    stacked_user_turn,
    with_interjections,
)
from engine.inference.steering import interjections_by_answer
from engine.agents.trial_drafts import TrialAgent, overlay_approvals, trial_drafts
from utils.validators import load_conversation_full
from engine.inference.runs.state import ACTIVE_RUN_STATUSES, _now
from engine.inference.runs.runtime import InferenceRunRuntime
from engine.inference.runs.decisions import (
    _agent_resume_item,
    hitl_resolved_value,
    overall_hitl_decision,
    run_is_interactive,
)
from engine.inference.runs.payloads import (
    _load_run,
    build_run_event_payload,
    build_run_out_from_message,
)
from engine.inference.runs.finish import (
    _mark_run_cancelled,
    _mark_run_completed,
    _mark_run_failed,
    _run_finished,
)
from utils.sse import parse_sse_bytes

logger = get_logger(__name__)


def _effective_personalization(prefs_row: UserPreferencesTable | None) -> dict[str, Any]:
    """Reduce a preference row to the personalization payload a run should carry.

    Only *effective* data survives: the personality preset when non-default,
    and the custom-instruction text fields only while the user has the feature
    enabled and at least one field filled. Returns ``{}`` when nothing applies
    so the caller can omit the context key entirely — the agents service treats
    an absent key as "no personalization" (and re-validates whatever does
    arrive fail-closed).
    """
    if prefs_row is None:
        return {}
    payload: dict[str, Any] = {}

    personality = (prefs_row.personality or "").strip().lower()
    if personality and personality != "default":
        payload["personality"] = personality

    ci = prefs_row.custom_instructions if isinstance(prefs_row.custom_instructions, dict) else {}
    if ci.get("enabled"):
        fields = {
            key: value.strip()
            for key in ("nickname", "occupation", "traits", "about")
            if isinstance((value := ci.get(key)), str) and value.strip()
        }
        if fields:
            payload["custom_instructions"] = fields

    return payload


class InferenceRunManager:
    def __init__(self) -> None:
        self._tasks: dict[str, asyncio.Task[None]] = {}
        self._cancel_events: dict[str, asyncio.Event] = {}
        # Live run state exposed to stream subscribers: a late subscriber
        # gets one synthesized snapshot frame built from the in-process
        # runtime (full coalesced event log) instead of replaying the Redis
        # stream from 0, which makes MAXLEN trimming irrelevant.
        self._runtimes: dict[str, InferenceRunRuntime] = {}
        self._run_metas: dict[str, dict[str, Any]] = {}
        # HITL resume signalling: a per-run event flipped by the bridge /resume
        # route, plus the run's decisions queued per interrupt (never one shared
        # slot — parallel approvals answered together used to overwrite each
        # other). _run takes them from the queue and _do_resume forwards them to
        # the agents-service /resume endpoint. Both live exactly as long as the
        # run's task: the done callback drops them however the run ends.
        self._resume_events: dict[str, asyncio.Event] = {}
        self._resume_queues: dict[str, HitlDecisionQueue] = {}

    def launch(self, run_id: str) -> None:
        if run_id in self._tasks and not self._tasks[run_id].done():
            return
        cancel_event = asyncio.Event()
        self._cancel_events[run_id] = cancel_event
        self._resume_events[run_id] = asyncio.Event()
        self._resume_queues[run_id] = HitlDecisionQueue()
        task = asyncio.create_task(self._run(run_id, cancel_event))
        self._tasks[run_id] = task
        task.add_done_callback(lambda _: (
            self._tasks.pop(run_id, None),
            self._cancel_events.pop(run_id, None),
            self._runtimes.pop(run_id, None),
            self._run_metas.pop(run_id, None),
            self._resume_events.pop(run_id, None),
            self._resume_queues.pop(run_id, None),
        ))

    def request_cancel(self, run_id: str) -> bool:
        event = self._cancel_events.get(run_id)
        if event:
            event.set()
            return True
        return False

    def request_resume(self, run_id: str, payload: dict[str, Any]) -> ResumeOutcome:
        """Queue one HITL decision for a live run and wake its _run task.

        Accepted only for an interrupt the run is paused on right now —
        ``payload["interrupt_id"]``, or the first undecided pending interrupt
        when the client names none. The run need not be idle: while a resume
        leg for one approval is still streaming, the decisions for the other
        pending approvals queue up and go out as soon as that leg ends. Each
        decision is kept under its own interrupt, so none can overwrite
        another.

        Refused (the route answers 409 with ``outcome.detail``): no live run on
        this process, a run not paused on any interrupt, an interrupt that is
        not pending on it, a second *different* decision for the same
        interrupt, or no interrupt left without a decision. The same decision
        sent twice is :attr:`ResumeOutcome.ALREADY_RECEIVED` — accepted, queued
        once.
        """
        event = self._resume_events.get(run_id)
        queue = self._resume_queues.get(run_id)
        runtime = self._runtimes.get(run_id)
        if event is None or queue is None or runtime is None or not self.has_live_task(run_id):
            return ResumeOutcome.NOT_PAUSED
        outcome, _token = queue.offer(payload, runtime.pending_interrupt_ids)
        if outcome is ResumeOutcome.ACCEPTED:
            event.set()
        return outcome

    def has_live_task(self, run_id: str) -> bool:
        task = self._tasks.get(run_id)
        return bool(task and not task.done())

    def build_live_snapshot(self, run_id: str) -> dict[str, Any] | None:
        """Synthesize a snapshot frame for an in-flight run from the
        in-process runtime: full coalesced event log + current run meta.

        Returns None when this process doesn't own a live task for the run
        (other replica, or the run already terminated) — callers fall back to
        replaying the Redis stream from the beginning.
        """
        runtime = self._runtimes.get(run_id)
        run_meta = self._run_metas.get(run_id)
        if runtime is None or run_meta is None or not self.has_live_task(run_id):
            return None
        return {
            "type": "snapshot",
            "run": {
                **run_meta,
                "updatedAt": _now().isoformat(),
                "pendingInterrupts": runtime.pending_interrupts,
                "rawEvents": deepcopy(runtime.raw_events),
            },
            "message": None,
            "summary": None,
        }

    async def publish_run_status(self, run: MessageTable, *, user_id: str) -> None:
        """Publish a status-only delta frame (no events) so observers learn
        about lifecycle flips that happen outside the stream loop, e.g. a
        cancel request moving the run to ``cancelling``/``cancelled``.
        """
        frame = {
            "type": "events",
            "events": [],
            "run": build_run_out_from_message(run, user_id=user_id).model_dump(mode="json", by_alias=False),
        }
        await self.publish(run.id, frame)

    async def publish(self, run_id: str, event: dict[str, Any]) -> None:
        """Append the event to the durable per-run Redis Stream.

        Subscribers consume via :func:`stream_run_events` over the SSE
        endpoint, backed by the same stream. Failure to write is logged but
        never raised — losing the wire frame is preferable to crashing the
        inference run.
        """
        try:
            await event_log.append(run_id, event)
        except Exception:
            logger.error(
                "event_log_publish_failed",
                "Failed to append inference event to Redis stream",
                exc_info=True,
                run_id=run_id,
            )

    async def _run(self, run_id: str, cancel_event: asyncio.Event) -> None:
        runtime = InferenceRunRuntime()
        self._runtimes[run_id] = runtime
        try:
            async with SessionLocal() as db:
                run = await _load_run(db, run_id)
                if not run or run.streaming_status not in ACTIVE_RUN_STATUSES:
                    return
                run.streaming_status = "running"
                run.updated_at = _now()
                await db.commit()

            async with SessionLocal() as db:
                run = await _load_run(db, run_id)
                if not run:
                    return
                # The owning user_id is resolved via the conversation row since
                # the assistant message itself doesn't carry user_id directly.
                conv_row = await db.get(ConversationTable, run.conversation_id)
                if not conv_row:
                    return
                user_id = conv_row.user_id
                # Reload with eager-loaded messages for the inference history builder.
                # Ordinary and trial conversations alike: this task serves both.
                conversation = await load_conversation_full(db, user_id, run.conversation_id, trial=None)
                started_at = run.streaming_started_at or run.created_at
                # Capture static run fields once so the stream loop can build
                # lightweight in-memory events without hitting the DB per chunk.
                run_meta: dict[str, Any] = {
                    "id": run.id,
                    "userId": user_id,
                    "conversationId": run.conversation_id,
                    "assistantMessageId": run.id,
                    "parentMessageId": run.parent_message_id,
                    "status": "running",
                    "messagePath": run.streaming_message_path or [],
                    "startedAt": started_at.isoformat(),
                    "updatedAt": started_at.isoformat(),
                    "errorMessage": None,
                    "completedAt": None,
                    "cancelRequestedAt": None,
                }
                self._run_metas[run_id] = run_meta
                # Per-message agent: resolve from the run (the AI message) so a
                # conversation can mix agents. Fall back to the conversation's
                # agent for pre-migration runs whose message has no agent_id.
                # A "Try it" trial (plan 40) runs the draft its start stashed:
                # an existing agent's own row, or a stand-in for a new draft.
                trial_draft = None
                if conversation.is_trial:
                    trial_draft = await trial_drafts.get(run_id)
                    await trial_drafts.delete(run_id)
                    if trial_draft is None:
                        await _mark_run_failed(run_id, runtime, "The draft for this trial run expired. Send it again.")
                        await self._publish_snapshot(run_id, "terminal")
                        return
                    agent = (
                        await get_agent_by_id(run.agent_id) if run.agent_id else trial_draft.agent_for(str(user_id))
                    )
                else:
                    agent = await get_agent_by_id(run.agent_id or conversation.agent_id)
                agent_url = build_agent_stream_url(agent)
                resume_url = build_agent_resume_url(agent)
                # Deep agents have a per-conversation filesystem; LangGraph
                # agents do not. Only deep agents get files seeded into input/
                # and the input/ path references in serialised attachments.
                is_deep_agent = getattr(agent, "type", "") == "deep agent"

                # Decide how to feed the agent this turn against its durable
                # checkpoint thread (re-derived from the message tree):
                #   delta_resume — the branch thread already has committed state
                #     (a `send` continuing the leaf) → send only the new message.
                #   delta_fork — a fresh branch thread (edit/retry) whose fork
                #     point is a committed ancestor on the parent branch → send
                #     the new message + fork_from so the agent seeds the new
                #     thread from that checkpoint before running.
                #   full_seed — no committed checkpoint to resume/fork from (new
                #     conversation, pre-migration branch, shared_continue, or a
                #     fork target that never committed) → send the full
                #     reconstructed history, seeding a fresh checkpoint. The next
                #     turn on this branch is then delta.
                # thread_id is branch-scoped (shared across a branch's runs);
                # run.id stays the per-run id (run_id below) the agents-service
                # normalizer uses for AG-UI message_id + namespace bindings.
                thread_id = run.checkpoint_thread_id or str(run.id)
                parent_user_message = next(
                    (m for m in conversation.messages if m.id == run.parent_message_id), None
                )
                committed_ancestor = nearest_committed_ai(conversation.messages, run.parent_message_id)
                fork_from: dict[str, str] | None = None

                if (
                    parent_user_message is not None
                    and committed_ancestor is not None
                    and committed_ancestor.checkpoint_thread_id == thread_id
                ):
                    payload_mode = "delta_resume"
                elif parent_user_message is not None and committed_ancestor is not None:
                    payload_mode = "delta_fork"
                    fork_from = {
                        "thread_id": committed_ancestor.checkpoint_thread_id,
                        "checkpoint_id": committed_ancestor.checkpoint_id,
                        # The answers up to the fork point: the new branch's
                        # conversation files are cut there, like its state.
                        "messages": answers_up_to(conversation.messages, committed_ancestor.id),
                    }
                else:
                    payload_mode = "full_seed"

                # Messages the user sent while answers ran (steering) are not
                # in the branch tree: a rebuilt history puts each in front of
                # the answer that read it, and this run's own — a retry carries
                # the retried answer's — follow its user message.
                if payload_mode == "full_seed":
                    history_messages, history = prepare_inference_history(
                        logger=logger,
                        messages=conversation.messages,
                        message_ids=run.streaming_message_path,
                        include_input_paths=is_deep_agent,
                    )
                    answer_ids = [m.id for m in history_messages if m.sender == "ai"]
                    interjections = await interjections_by_answer(db, [*answer_ids, run.id])
                    history = with_interjections(
                        history_messages, history, interjections, include_input_paths=is_deep_agent
                    )
                else:
                    interjections = await interjections_by_answer(db, [run.id])
                    history = [
                        serialise_message_with_images_for_agent(message, include_input_paths=is_deep_agent)
                        for message in stacked_user_turn(conversation.messages, parent_user_message)
                    ]
                own_interjections = interjections.get(run.id, [])
                history.extend(
                    serialise_message_with_images_for_agent(row, include_input_paths=is_deep_agent)
                    for row in own_interjections
                )
                sent_messages = len(history)
                if own_interjections:
                    # The answer shows them as it would have mid-run: at its start.
                    carried = [
                        event for event in (
                            runtime.apply_event({
                                "type": "CUSTOM",
                                "name": "USER_INTERJECTION",
                                "value": {"text": row.content or ""},
                                "timestamp": int(time.time() * 1000),
                            })
                            for row in own_interjections
                        )
                        if event is not None
                    ]
                    await self._publish_delta(run_id, run_meta, runtime, carried)

                logger.info(
                    "inference_run_started",
                    "Detached inference run started",
                    run_id=run.id,
                    conversation_id=run.conversation_id,
                    thread_id=thread_id,
                    payload_mode=payload_mode,
                    forked=fork_from is not None,
                    sent_messages=sent_messages,
                )
                # Per-user prefs, loaded once and threaded into the run context.
                # `search_past_convs` (opt-in) gates the deep agent's
                # cross-conversation `search_past_conversations` tool; `use_memory`
                # (on by default) gates its persistent memory (the /memories/
                # AGENTS.md + entries mount and the `remember` tool). Both default
                # to the no-row stance.
                prefs_row = (
                    await db.execute(
                        select(UserPreferencesTable).where(UserPreferencesTable.user_id == user_id)
                    )
                ).scalar_one_or_none()
                search_past_convs = bool(prefs_row.search_past_convs) if prefs_row else False
                use_memory = bool(prefs_row.use_memory) if prefs_row else True
                if isinstance(agent, TrialAgent):
                    # A never-created draft writes no memory under a slug that
                    # has no agent yet (plan 40). A trial of a saved agent keeps
                    # the user's setting: it is that agent's real memory.
                    use_memory = False
                # Personalization (personality preset + custom instructions) from
                # the same row — only *effective* data is threaded: the preset
                # when non-default, the custom-instruction fields only while the
                # user has them enabled and non-empty. A run with no effective
                # personalization carries no `personalization` key at all, so
                # its agent prompt is byte-identical to the pre-feature one. The
                # agents service re-validates the payload fail-closed on its side.
                personalization = _effective_personalization(prefs_row)
                if isinstance(agent, TrialAgent):
                    # No saved rows belong to a draft that was never created.
                    tool_config = {"enabled": [], "disabled": [], "approvals": {}}
                else:
                    tool_config = await agent_tool_prefs.read_config(db, str(user_id), agent.slug)
                if trial_draft is not None:
                    # The draft's Approvals choices, for this run only.
                    tool_config = overlay_approvals(tool_config, trial_draft.approvals)

                # Shared config block forwarded to both the initial /stream call
                # and any /resume legs. thread_id keys the durable saver (branch-
                # scoped); run_id is the per-run identity for the AG-UI layer.
                base_request_config: dict[str, Any] = {
                    "run_config": {
                        "configurable": {"thread_id": thread_id},
                    },
                    "context": {
                        "user_id": str(user_id),
                        "conversation_id": str(run.conversation_id),
                        "run_id": str(run.id),
                        "search_past_convs": search_past_convs,
                        "use_memory": use_memory,
                        # Someone is watching this run and can answer it. A
                        # scheduled task's run has nobody to resume a pause,
                        # so its agent never gets `ask_user`.
                        "interactive": run_is_interactive(run),
                        # The user's per-agent tool choices, from chat_db,
                        # decoded once by the agent's abstraction layer. They
                        # ride the run config rather than being materialised on
                        # the agents volume, exactly like the two above.
                        "tool_config": tool_config,
                        # Whose agent this is: absent/None for a platform agent,
                        # the owner's id for a user-authored one. The agents
                        # service resolves the definition from the global
                        # registry or that user's workspace accordingly — the DB
                        # is the authority, so a user can never shadow a
                        # platform agent by naming theirs the same.
                        **(
                            {"agent_owner_id": str(agent.owner_user_id)}
                            if getattr(agent, "owner_user_id", None)
                            else {}
                        ),
                        **({"personalization": personalization} if personalization else {}),
                        # The slash command this turn runs (plan 35). It rides the
                        # shared block, so the /resume legs of a paused run keep
                        # it too — a paused /code-review must stay read-only.
                        **command_context(parent_user_message),
                        # The reasoning effort the user picked for this turn,
                        # only when they picked one: without it the key is
                        # absent and the config is what it was before. Same
                        # shared block, so retry and resume legs keep it.
                        **effort_context(parent_user_message),
                        # Ask agent on a canvas selection (plan 44 4.3): the
                        # passage and the instruction, only on the turn whose
                        # user message carries one. Same shared block, so the
                        # resume legs and a retry keep it.
                        **canvas_edit_context(parent_user_message),
                    },
                }
                if fork_from is not None:
                    # Consumed by /stream only (idempotent seed before the run);
                    # /resume ignores it.
                    base_request_config["fork_from"] = fork_from
                request_payload: dict[str, Any] = {
                    "messages": history,
                    "config": base_request_config,
                }
                # A trial sends its draft inline on the stream and on every
                # resume leg; the agents service builds it uncached from that
                # instead of loading (agent_owner_id, slug) from its database.
                resume_extra: dict[str, Any] = {}
                if trial_draft is not None:
                    request_payload["definition"] = trial_draft.definition
                    resume_extra["definition"] = trial_draft.definition

            cancel_waiter = asyncio.create_task(cancel_event.wait())
            # First leg: the initial /stream call. Subsequent legs (if any) come
            # from /resume after each HITL interrupt.
            stream_task: asyncio.Task[str] = asyncio.create_task(
                self._do_stream(run_id, run_meta, runtime, agent_url, request_payload)
            )

            # The decisions of the resume leg in flight, kept until it ends: a
            # stale refusal puts the ones the agent can still take back.
            inflight: list[tuple[str, dict[str, Any]]] = []
            try:
                while True:
                    done, _ = await asyncio.wait(
                        {stream_task, cancel_waiter},
                        return_when=asyncio.FIRST_COMPLETED,
                    )

                    # Cancellation wins outright: kill the in-flight HTTP stream
                    # and mark the run cancelled. _do_stream may emit one more
                    # frame after cancellation; that's fine — it's in Redis.
                    if cancel_waiter in done and stream_task not in done:
                        stream_task.cancel()
                        await asyncio.gather(stream_task, return_exceptions=True)
                        await _mark_run_cancelled(run_id, runtime)
                        await self._publish_snapshot(run_id, "terminal")
                        return

                    # Stream leg ended. Surface upstream errors, then decide
                    # whether the run is genuinely terminal, paused on a HITL
                    # interrupt, or implicitly failed.
                    if not stream_task.cancelled():
                        exc = stream_task.exception()
                        if isinstance(exc, StaleDecisions):
                            # Some decisions named interrupts the agent no longer
                            # has: nothing was applied. Void those, queue the rest
                            # again and stay paused — never fail a run that still
                            # has approvals to answer.
                            if not await self._recover_from_stale(run_id, run_meta, runtime, inflight, exc):
                                return
                        elif exc:
                            raise exc
                        elif stream_task.result() == "failed":
                            # _do_stream already marked the run failed via _finish_run.
                            return
                    inflight = []

                    if cancel_event.is_set():
                        await _mark_run_cancelled(run_id, runtime)
                        await self._publish_snapshot(run_id, "terminal")
                        return

                    # No interrupt pending → normal terminal completion.
                    if runtime.pending_interrupts <= 0:
                        await _mark_run_completed(run_id, runtime)
                        await self._publish_snapshot(run_id, "terminal")
                        return

                    # Paused on HITL interrupt(s). Hold the task alive and race
                    # the cancel event against the bridge /resume signal.
                    resume_event = self._resume_events.get(run_id)
                    decision_queue = self._resume_queues.get(run_id)
                    if resume_event is None or decision_queue is None:
                        # Shouldn't happen (launch sets them) — treat as failure.
                        await _mark_run_failed(run_id, runtime, "Resume signalling not initialised.")
                        await self._publish_snapshot(run_id, "terminal")
                        return

                    # A pause that came back on an interrupt already answered is
                    # a new question: it takes a new decision.
                    decision_queue.forget_answered(runtime.pending_interrupt_ids)
                    logger.info(
                        "inference_run_awaiting_resume",
                        "Run paused on HITL interrupt; awaiting resume signal",
                        run_id=run_id,
                        pending_interrupts=runtime.pending_interrupts,
                        queued_decisions=len(decision_queue),
                    )

                    # Decisions that arrived while the last leg streamed go out
                    # at once; otherwise wait for the next one. The queue is
                    # checked right after clearing the event, with no await in
                    # between, so a decision can never slip past the wait.
                    batch = settings.inference.batch_hitl_resume
                    ready = decision_queue.take_ready(runtime.pending_interrupt_ids, batch=batch)
                    while not ready:
                        resume_event.clear()
                        resume_waiter = asyncio.create_task(resume_event.wait())
                        try:
                            done, _ = await asyncio.wait(
                                {resume_waiter, cancel_waiter},
                                return_when=asyncio.FIRST_COMPLETED,
                            )
                        finally:
                            if not resume_waiter.done():
                                resume_waiter.cancel()
                                await asyncio.gather(resume_waiter, return_exceptions=True)

                        if cancel_waiter in done:
                            await _mark_run_cancelled(run_id, runtime)
                            await self._publish_snapshot(run_id, "terminal")
                            return
                        ready = decision_queue.take_ready(runtime.pending_interrupt_ids, batch=batch)

                    # Resolve the identities we're now answering and kick off
                    # /resume — one leg for the whole batch.
                    resume_payloads = [payload for _token, payload in ready]
                    markers: list[dict[str, Any]] = []
                    for token, resume_payload in ready:
                        runtime.resolve_interrupt(token)
                        # Persist each resolution in the event log itself so a
                        # reloaded client doesn't re-show an answered approval —
                        # resolution state must survive in the durable log, not
                        # in client memory; the UI also waits for this marker
                        # before it stops offering the approval.
                        marker = runtime.apply_event({
                            "type": "CUSTOM",
                            "name": "BRIDGE_HITL_RESOLVED",
                            "value": hitl_resolved_value(resume_payload, overall_hitl_decision(resume_payload)),
                            "timestamp": int(time.time() * 1000),
                        })
                        if marker is not None:
                            markers.append(marker)
                    await self._publish_delta(run_id, run_meta, runtime, markers)
                    logger.info(
                        "inference_run_resume_dispatched",
                        "Dispatching resume to agents service",
                        run_id=run_id,
                        interrupt_id=resume_payloads[0].get("interrupt_id"),
                        interrupt_ids=[p.get("interrupt_id") for p in resume_payloads],
                        decision=resume_payloads[0].get("decision"),
                        batched=len(resume_payloads),
                        still_queued=len(decision_queue),
                    )

                    inflight = list(ready)
                    stream_task = asyncio.create_task(
                        self._do_resume(
                            run_id, run_meta, runtime, resume_url, base_request_config, resume_payloads,
                            **resume_extra,
                        )
                    )
            finally:
                if not cancel_waiter.done():
                    cancel_waiter.cancel()
                    await asyncio.gather(cancel_waiter, return_exceptions=True)
        except asyncio.CancelledError:
            await _mark_run_cancelled(run_id, runtime)
            await self._publish_snapshot(run_id, "terminal")
        except Exception:
            logger.error("inference_run_failed", "Detached inference run failed", exc_info=True, run_id=run_id)
            await _mark_run_failed(run_id, runtime, "The agent stream ended unexpectedly.")
            await self._publish_snapshot(run_id, "terminal")
        finally:
            self._cancel_events.pop(run_id, None)

    async def _do_stream(
        self,
        run_id: str,
        run_meta: dict[str, Any],
        runtime: InferenceRunRuntime,
        agent_url: str,
        request_payload: dict[str, Any],
    ) -> str:
        sse_buffer = ""
        timeout = settings.http.inference_timeout
        async with httpx.AsyncClient(timeout=timeout, verify=get_httpx_verify(), cert=get_httpx_client_cert()) as client:
            headers = internal_service_headers(get_context().get("request_id"))
            headers["Accept"] = "text/event-stream"
            async with client.stream("POST", agent_url, json=request_payload, headers=headers) as response:
                response.raise_for_status()
                async for chunk in response.aiter_bytes():
                    sse_buffer, events = parse_sse_bytes(sse_buffer, chunk)
                    new_events: list[dict[str, Any]] = []
                    for event in events:
                        if event.get("type") == "RUN_ERROR":
                            runtime.apply_event(event)
                            await _mark_run_failed(run_id, runtime, str(event.get("message") or "Agent stream failed."))
                            await self._publish_snapshot(run_id, "terminal")
                            return "failed"
                        applied = runtime.apply_event(event)
                        if applied is not None:
                            new_events.append(applied)
                    if new_events:
                        await self._publish_delta(run_id, run_meta, runtime, new_events)
        return "completed"

    async def _do_resume(
        self,
        run_id: str,
        run_meta: dict[str, Any],
        runtime: InferenceRunRuntime,
        resume_url: str,
        base_request_config: dict[str, Any],
        resume_payloads: dict[str, Any] | list[dict[str, Any]],
        definition: dict[str, Any] | None = None,
    ) -> str:
        """Resume a paused HITL run via the agents-service /resume endpoint.

        The body shape matches :class:`AgentResumeRequest` on the agents side:
        the first decision in the top-level fields (the one-at-a-time shape)
        and, when several pending interrupts are answered at once, all of them
        under ``resumes`` — the agents service then applies them together as
        ``Command(resume={interrupt_id: value, ...})``. Output framing is
        identical to ``/stream`` so the existing SSE parser, runtime
        accumulator, and Redis publisher all work unchanged.
        """
        payloads = [resume_payloads] if isinstance(resume_payloads, dict) else list(resume_payloads)
        sse_buffer = ""
        thread_id = base_request_config.get("run_config", {}).get("configurable", {}).get("thread_id", "")
        body: dict[str, Any] = {
            "config": base_request_config,
            "thread_id": thread_id,
            **_agent_resume_item(payloads[0]),
        }
        if len(payloads) > 1:
            body["resumes"] = [_agent_resume_item(payload) for payload in payloads]
        if definition is not None:
            # A "Try it" trial (plan 40): the draft rides every leg.
            body["definition"] = definition
        timeout = settings.http.inference_timeout
        async with httpx.AsyncClient(timeout=timeout, verify=get_httpx_verify(), cert=get_httpx_client_cert()) as client:
            headers = internal_service_headers(get_context().get("request_id"))
            headers["Accept"] = "text/event-stream"
            try:
                async with client.stream("POST", resume_url, json=body, headers=headers) as response:
                    if response.status_code == 409:
                        # Stale interrupts (listed) are recoverable; any other
                        # 409 is "no paused checkpoint" and fails the run below.
                        await response.aread()
                        try:
                            stale = stale_decisions_from_conflict(response.json())
                        except ValueError:
                            stale = None
                        if stale is not None:
                            raise stale
                    response.raise_for_status()
                    async for chunk in response.aiter_bytes():
                        sse_buffer, events = parse_sse_bytes(sse_buffer, chunk)
                        new_events: list[dict[str, Any]] = []
                        for event in events:
                            if event.get("type") == "RUN_ERROR":
                                runtime.apply_event(event)
                                await _mark_run_failed(run_id, runtime, str(event.get("message") or "Agent resume failed."))
                                await self._publish_snapshot(run_id, "terminal")
                                return "failed"
                            applied = runtime.apply_event(event)
                            if applied is not None:
                                new_events.append(applied)
                        if new_events:
                            await self._publish_delta(run_id, run_meta, runtime, new_events)
            except httpx.HTTPStatusError as exc:
                # 409 → no paused checkpoint at all (stale interrupts were
                # raised as StaleDecisions above and never reach this).
                # Anything else upstream → fail the run with the status code in the message.
                status_code = exc.response.status_code if exc.response is not None else None
                detail = "Inference run could not be resumed."
                if status_code == 409:
                    detail = "The agent has no paused checkpoint for this run. Start a new message instead."
                await _mark_run_failed(run_id, runtime, detail)
                await self._publish_snapshot(run_id, "terminal")
                return "failed"
        return "completed"

    async def _recover_from_stale(
        self,
        run_id: str,
        run_meta: dict[str, Any],
        runtime: InferenceRunRuntime,
        inflight: list[tuple[str, dict[str, Any]]],
        stale: StaleDecisions,
    ) -> bool:
        """Recover from a resume the agents service refused over stale interrupts.

        Nothing of that resume was applied. Each decision for an interrupt the
        agent no longer has gets an ``expired`` resolved marker (the UI drops
        its card and says it was not applied); the others go back in the queue
        to be sent again at once. An interrupt the bridge still waits on but the
        agent no longer lists is voided too, so the run never waits on a
        question nobody can answer.

        Returns True when the run stays paused on what is left. When nothing is
        left, the run ends here (False): completed when the agent has nothing
        paused either (its answer is done; there is nothing to resume), failed
        only when the agent waits on approvals this run does not know of.
        """
        queue = self._resume_queues.get(run_id)
        stale_ids = set(stale.stale_ids)
        agent_pending = set(stale.pending_ids)

        def gone(token: str) -> bool:
            if token in stale_ids or not agent_pending:
                # Named stale, or the agent is paused on nothing at all.
                return True
            return not token.startswith("anon-") and token not in agent_pending

        voided: list[str] = []
        restored: list[str] = []
        for token, payload in inflight:
            if gone(token):
                voided.append(token)
            elif queue is not None:
                queue.restore(token, payload)
                restored.append(token)
        for token in list(runtime.pending_interrupt_ids):
            if gone(token):
                runtime.resolve_interrupt(token)
                if queue is not None:
                    queue.discard(token)
                voided.append(token)
        runtime.pending_interrupt_ids = restored + [t for t in runtime.pending_interrupt_ids if t not in restored]

        markers = [
            marker
            for token in dict.fromkeys(voided)
            if (marker := runtime.apply_event({
                "type": "CUSTOM",
                "name": "BRIDGE_HITL_RESOLVED",
                "value": {"interrupt_id": token, "decision": EXPIRED_DECISION, "reason": EXPIRED_REASON, "decisions": None},
                "timestamp": int(time.time() * 1000),
            })) is not None
        ]
        if markers:
            await self._publish_delta(run_id, run_meta, runtime, markers)
        logger.warning(
            "inference_run_resume_stale",
            "Agents service refused stale interrupts; voided them and queued the rest again",
            run_id=run_id,
            stale_interrupt_ids=sorted(stale_ids),
            voided_interrupt_ids=list(dict.fromkeys(voided)),
            requeued_interrupt_ids=restored,
            pending_interrupts=runtime.pending_interrupts,
        )
        if runtime.pending_interrupts > 0:
            return True
        if not agent_pending:
            await _mark_run_completed(run_id, runtime)
        else:
            await _mark_run_failed(
                run_id, runtime, "The agent's pending approvals no longer match this run. Start a new message instead."
            )
        await self._publish_snapshot(run_id, "terminal")
        return False

    async def _publish_delta(
        self,
        run_id: str,
        run_meta: dict[str, Any],
        runtime: InferenceRunRuntime,
        events: list[dict[str, Any]],
    ) -> None:
        """Publish the new seq-stamped events of one upstream chunk.

        Frames are O(chunk), not O(run): the client folds them into its
        timeline incrementally and a late subscriber gets the synthesized
        snapshot frame first, so nothing here needs to be cumulative.
        """
        frame = {
            "type": "events",
            "run": {
                **run_meta,
                "updatedAt": _now().isoformat(),
                "pendingInterrupts": runtime.pending_interrupts,
            },
            "events": events,
        }
        await self.publish(run_id, frame)

    async def _publish_snapshot(self, run_id: str, event_type: str) -> None:
        async with SessionLocal() as db:
            payload = await build_run_event_payload(db, run_id, event_type)
        if payload:
            await self.publish(run_id, payload)
        if event_type == "terminal":
            # Stamp a TTL on the stream so reconnecting clients can still replay
            # for the configured window. After expiry Redis drops the stream and
            # the durable record stays in PostgreSQL.
            try:
                await event_log.mark_terminal(run_id)
            except Exception:
                logger.warning(
                    "event_log_mark_terminal_failed",
                    "Failed to set terminal TTL on Redis stream",
                    exc_info=True,
                    run_id=run_id,
                )
            # The conversation's slot is free and observers have the final
            # state: now its queued message, or a pending wake-up, may start.
            await _run_finished(run_id)


inference_run_manager = InferenceRunManager()
