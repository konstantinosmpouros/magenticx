"""Background sub-agent tasks (plan 41 §5, §14.4): REST and SSE streams.

Thin: every route checks the session, the user binding and ownership, and
hands the work to ``engine/inference/tasks/tasks.py`` / ``engine/inference/composer_queue.py``.
Two routers, because half the surface hangs off a conversation:

* ``router`` (``/v1/tasks``) — one task: stop it, answer its approval, watch
  its live events (the drill-down stream);
* ``conversation_router`` (``/v1/conversations``) — a conversation's task
  tree, its queued composer message, and the conversation channel stream.

The watched streams are Server-Sent Events (``GET …/events``, SSE plan): the
normal HTTP dependencies do auth, ownership (``404``), the cursor (``400``)
and the per-user connect limit before the stream opens.
"""
from fastapi import APIRouter, Depends, HTTPException, Path, Query, Response, status
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession

from core.auth.session import AuthUser, require_csrf_protection
from core.database import get_db
from core.logging import get_logger, set_context
from core.security.rate_limit import stream_connect_rate_limit, task_mutate_rate_limit, task_read_rate_limit
from core.settings import settings
from schema import ActiveConversationsOut, TaskOut, TaskResumeIn, queued_messages_from_column
from utils.sse import SSE_RESPONSE_HEADERS, frames_to_sse
from utils.validators import validate_stream_cursor, validate_userId
from engine.inference.tasks.tasks import (
    active_conversation_ids,
    cancel_task_for_user,
    get_owned_task,
    list_conversation_tasks,
    owned_conversation,
    resume_task_for_user,
    stream_task_events,
)
from engine.inference.composer_queue import cancel_queued_message
from engine.inference.channel import channel_frames

logger = get_logger(__name__)

router = APIRouter()
conversation_router = APIRouter()

# ---------------------------------------------------------------------------
# REST
# ---------------------------------------------------------------------------
@conversation_router.get("/{user_id}/{conversation_id}/tasks", response_model=list[TaskOut])
async def listConversationTasks(
    user_id: str,
    conversation_id: str,
    limit: int = Query(default=200, ge=1),
    current_user: AuthUser = Depends(validate_userId),
    _rate_limited: None = Depends(task_read_rate_limit),
    db: AsyncSession = Depends(get_db),
) -> list[TaskOut]:
    """The conversation's background task tree, from the bridge's mirror."""
    set_context(user_id=user_id, conversation_id=conversation_id)
    return await list_conversation_tasks(db, current_user.id, conversation_id, limit)


@conversation_router.delete(
    "/{user_id}/{conversation_id}/queued-messages/{message_id}", status_code=status.HTTP_204_NO_CONTENT
)
async def deleteQueuedMessage(
    user_id: str,
    conversation_id: str,
    message_id: str = Path(min_length=1, max_length=64),
    current_user: AuthUser = Depends(validate_userId),
    _: None = Depends(require_csrf_protection),
    _rate_limited: None = Depends(task_mutate_rate_limit),
    db: AsyncSession = Depends(get_db),
) -> Response:
    """Cancel one of the conversation's queued composer messages before it is sent (404 when it is gone)."""
    set_context(user_id=user_id, conversation_id=conversation_id)
    await cancel_queued_message(db, current_user.id, conversation_id, message_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/{user_id}/active-conversations", response_model=ActiveConversationsOut)
async def listActiveConversations(
    user_id: str,
    current_user: AuthUser = Depends(validate_userId),
    _rate_limited: None = Depends(task_read_rate_limit),
    db: AsyncSession = Depends(get_db),
) -> ActiveConversationsOut:
    """The caller's conversations whose background tasks are still working."""
    set_context(user_id=user_id)
    return await active_conversation_ids(db, current_user.id)


@router.post("/{user_id}/{task_id}/cancel", response_model=TaskOut)
async def cancelTask(
    user_id: str,
    task_id: str,
    current_user: AuthUser = Depends(validate_userId),
    _: None = Depends(require_csrf_protection),
    _rate_limited: None = Depends(task_mutate_rate_limit),
    db: AsyncSession = Depends(get_db),
) -> TaskOut:
    """The Stop button: cancel a task and its whole subtree."""
    set_context(user_id=user_id)
    return await cancel_task_for_user(db, current_user.id, task_id)


@router.post("/{user_id}/{task_id}/resume", response_model=TaskOut)
async def resumeTask(
    user_id: str,
    task_id: str,
    payload: TaskResumeIn,
    current_user: AuthUser = Depends(validate_userId),
    _: None = Depends(require_csrf_protection),
    _rate_limited: None = Depends(task_mutate_rate_limit),
    db: AsyncSession = Depends(get_db),
) -> TaskOut:
    """Answer the approval a ``waiting`` task is paused on."""
    set_context(user_id=user_id)
    return await resume_task_for_user(db, current_user.id, task_id, payload)


# ---------------------------------------------------------------------------
# Server-Sent Events
# ---------------------------------------------------------------------------
@conversation_router.get("/{user_id}/{conversation_id}/events")
async def conversation_events(
    user_id: str,
    conversation_id: str,
    cursor: str | None = Depends(validate_stream_cursor),
    current_user: AuthUser = Depends(validate_userId),
    _rate_limited: None = Depends(stream_connect_rate_limit),
    db: AsyncSession = Depends(get_db),
) -> StreamingResponse:
    """The conversation channel over SSE — the frames of the socket below, one
    event each (``event:`` = the frame's ``type``, ``id:`` = its ``seq``): the
    queue's state first, then ``task``, ``run_started`` and ``queue`` frames.
    Resume with ``?since=`` or ``Last-Event-ID``; the stream never ends on its
    own, and a ``: ping`` keeps it open while quiet."""
    conversation = await owned_conversation(db, current_user.id, conversation_id)
    if conversation is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Conversation not found.")
    queued = queued_messages_from_column(conversation.queued_messages)
    # Nothing else is read on this session: give its connection back before a
    # stream that stays open as long as the conversation is.
    await db.close()
    set_context(user_id=user_id, conversation_id=conversation_id)
    logger.info("conversation_sse_subscribe", "Conversation channel SSE subscriber attached", replay=bool(cursor))
    return StreamingResponse(
        frames_to_sse(channel_frames(conversation_id, cursor, queued), settings.inference.sse_heartbeat_seconds),
        media_type="text/event-stream",
        headers=SSE_RESPONSE_HEADERS,
    )


@router.get("/{user_id}/{task_id}/events")
async def task_events(
    user_id: str,
    task_id: str,
    cursor: str | None = Depends(validate_stream_cursor),
    current_user: AuthUser = Depends(validate_userId),
    _rate_limited: None = Depends(stream_connect_rate_limit),
    db: AsyncSession = Depends(get_db),
) -> StreamingResponse:
    """One task's live events over SSE, for its drill-down: ``snapshot``, then
    ``event`` frames (``id:`` = ``seq``), then ``terminal`` once it settles,
    after which the stream ends."""
    if await get_owned_task(db, current_user.id, task_id) is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Task not found.")
    await db.close()
    set_context(user_id=user_id)
    logger.info("task_sse_subscribe", "Task SSE subscriber attached", task_id=task_id, replay=bool(cursor))
    return StreamingResponse(
        frames_to_sse(stream_task_events(user_id, task_id, cursor), settings.inference.sse_heartbeat_seconds),
        media_type="text/event-stream",
        headers=SSE_RESPONSE_HEADERS,
    )
