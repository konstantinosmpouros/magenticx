from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession
from core.logging import get_logger, set_context

from core.database import get_db
from schema import (
    InferenceStartPayload,
    InferenceStartResponse,
    InferenceRunOut,
    InferenceRunResumeIn,
    QueuedStartResponse,
)
from core.auth.session import AuthUser, require_csrf_protection
from core.security.rate_limit import inference_rate_limit, stream_connect_rate_limit
from utils.sse import SSE_RESPONSE_HEADERS
from utils.validators import validate_stream_cursor, validate_userId
from engine.inference.runs.payloads import build_run_out_from_message
from engine.inference.runs.records import (
    get_active_run_for_user,
    list_runs_for_user,
    request_run_cancel,
    request_run_resume,
)
from engine.inference.runs.manager import inference_run_manager
from engine.inference.runs.finish import mark_run_launch_failed
from engine.inference.runs.stream import stream_run_sse
from engine.inference.hitl import ResumeOutcome
from engine.inference.composer_queue import queue_if_busy
from engine.inference.start import start_inference_flow


logger = get_logger(__name__)

router = APIRouter()


@router.post(
    "/runs/{user_id}/start",
    response_model=InferenceStartResponse | QueuedStartResponse,
    status_code=status.HTTP_201_CREATED,
)
async def startInferenceFlow(
    user_id: str,
    payload: InferenceStartPayload,
    response: Response,
    current_user: AuthUser = Depends(validate_userId),
    _: None = Depends(require_csrf_protection),
    # Per-user run-start ceiling.
    # After auth + CSRF on purpose: the bucket is keyed on the path's {user_id},
    # so it must only ever count requests that user actually made.
    _rate_limited: None = Depends(inference_rate_limit),
    db: AsyncSession = Depends(get_db),
) -> InferenceStartResponse | QueuedStartResponse:
    """Persist the user-side action, create the AI placeholder, and launch a backend-owned run.

    With ``queue_if_busy`` on a ``send`` to a conversation that has an active
    run, the message is queued instead (202, plan 41 §3.6) and sent when that
    run ends; without it, that case stays a 409.
    """
    set_context(user_id=user_id, conversation_id=payload.conversationId)
    queued = await queue_if_busy(db, current_user, payload)
    if queued is not None:
        response.status_code = status.HTTP_202_ACCEPTED
        return queued
    started = await start_inference_flow(db=db, user=current_user, payload=payload)
    try:
        inference_run_manager.launch(started.run.id)
    except Exception as exc:
        await mark_run_launch_failed(started.run.id)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Inference run could not be launched.",
        ) from exc
    return started


@router.get("/runs/{user_id}", response_model=list[InferenceRunOut])
async def listInferenceRuns(
    user_id: str,
    status_filter: str | None = Query(default=None, alias="status"),
    current_user: AuthUser = Depends(validate_userId),
    db: AsyncSession = Depends(get_db),
) -> list[InferenceRunOut]:
    """List inference runs for hydration; ``status=active`` returns queued/running/cancelling runs.

    After the inference_runs-table collapse, an inference run is just an
    assistant message with a non-null ``streaming_status`` column. We filter
    by streaming_status and join through ``conversations`` to scope to the
    requesting user.
    """
    runs = await list_runs_for_user(db, user_id, status_filter)
    return [build_run_out_from_message(message, user_id=user_id) for message in runs]


@router.get("/runs/{user_id}/{run_id}/events")
async def stream_inference_run_events(
    user_id: str,
    run_id: str,
    cursor: str | None = Depends(validate_stream_cursor),
    current_user: AuthUser = Depends(validate_userId),
    _rate_limited: None = Depends(stream_connect_rate_limit),
    db: AsyncSession = Depends(get_db),
) -> StreamingResponse:
    """Stream a run's events as Server-Sent Events (SSE plan).

    - ``event: snapshot`` once on a fresh subscribe (no cursor);
    - ``event: event`` with ``id: <seq>`` per stream entry (the new AG-UI
      events of one upstream chunk);
    - ``event: terminal`` with the DB-built final state, then the stream ends;
    - ``: ping`` comments while the run is quiet.

    Resume after a drop with ``?since=<seq>`` or the ``Last-Event-ID`` header
    (the query wins). Auth, ownership and the per-user connect limit are the
    normal HTTP dependencies; the run must be the caller's.
    """
    run = await get_active_run_for_user(db, user_id, run_id)
    if not run:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Inference run not found.")
    set_context(user_id=user_id, conversation_id=run.conversation_id)
    # Nothing else is read on this session: give its connection back before a
    # stream that may stay open for as long as the run.
    await db.close()
    logger.info(
        "sse_subscribe",
        "SSE subscriber attached",
        run_id=run_id,
        since=cursor or "",
        replay=bool(cursor),
    )
    return StreamingResponse(
        stream_run_sse(run_id, since=cursor),
        media_type="text/event-stream",
        headers=SSE_RESPONSE_HEADERS,
    )


@router.post("/runs/{user_id}/{run_id}/cancel", response_model=InferenceRunOut)
async def cancelInferenceRun(
    user_id: str,
    run_id: str,
    current_user: AuthUser = Depends(validate_userId),
    _: None = Depends(require_csrf_protection),
    db: AsyncSession = Depends(get_db),
) -> InferenceRunOut:
    run = await get_active_run_for_user(db, user_id, run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Inference run not found.")
    run = await request_run_cancel(db, run)
    await inference_run_manager.publish_run_status(run, user_id=user_id)
    return build_run_out_from_message(run, user_id=user_id)


@router.post("/runs/{user_id}/{run_id}/resume", response_model=InferenceRunOut)
async def resumeInferenceRun(
    user_id: str,
    run_id: str,
    payload: InferenceRunResumeIn,
    current_user: AuthUser = Depends(validate_userId),
    _: None = Depends(require_csrf_protection),
    db: AsyncSession = Depends(get_db),
) -> InferenceRunOut:
    """Send a HITL approve/reject decision to a paused inference run.

    Looks up the AI message, validates the requesting user owns the
    conversation, and queues the decision under the interrupt it answers. The
    manager's ``_run`` task dispatches queued decisions to the agents service
    ``/agents/{slug}/resume`` endpoint, which feeds a ``Command(resume=...)``
    into the saved LangGraph checkpoint. Resulting events flow through the
    same Redis stream + WS observers as the original run.

    A 200 means the decision is queued for an interrupt the run is paused on
    (or is an identical repeat of one already received) — it is applied when
    the run's ``BRIDGE_HITL_RESOLVED`` marker for it appears. Anything else is
    a 409 that says why: not paused, not a pending approval, or a different
    decision already received for it.
    """
    run = await get_active_run_for_user(db, user_id, run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Inference run not found.")

    resume_payload = {
        "decision": payload.decision,
        "reason": payload.reason,
        "value": payload.value,
        "interrupt_id": payload.interruptId,
        "decisions": [d.model_dump() for d in payload.decisions] if payload.decisions else None,
    }
    outcome = await request_run_resume(run, resume_payload)
    if not outcome.accepted:
        logger.warning(
            "inference_run_resume_refused",
            "Inference run resume refused",
            run_id=run.id,
            interrupt_id=payload.interruptId,
            decision=payload.decision,
            failure_reason=outcome.value,
        )
        raise HTTPException(status_code=409, detail=outcome.detail)

    logger.info(
        "inference_run_resume_received",
        "Inference run resume signalled from bridge",
        run_id=run.id,
        interrupt_id=payload.interruptId,
        decision=payload.decision,
        repeat=outcome is not ResumeOutcome.ACCEPTED,
    )
    return build_run_out_from_message(run, user_id=user_id)
