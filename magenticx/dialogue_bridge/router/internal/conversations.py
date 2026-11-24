"""Internal (service-to-service) endpoints over a conversation's uploads.

**Not** browser-facing: gated by `require_internal_caller` (the service secret,
`INTERNAL_SERVICE_SECRET`, which the UI never holds) AND blocked at the nginx edge (`/api/v1/internal/`), so only the
agents service — reaching the bridge directly on the `backend` network — can
call them. They back the agent's read-only ``/conversation/input/`` folder
(plan 36): the uploads stay here, and the agent reads them on demand. And the
steering claim (SSE plan, phase 5): a run takes the message the user sent
while it worked.
"""
from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from core.database import get_db
from core.logging import get_logger, set_context
from core.security.internal_trust import require_internal_caller
from schema import InputFilesOut, InterjectionClaimIn, InterjectionsOut
from engine.inference.steering import claim_interjection
from engine.conversations.inputs import (
    conversation_is_owned,
    list_input_files,
    read_input_file,
)

router = APIRouter(prefix="/conversations", dependencies=[Depends(require_internal_caller)])
logger = get_logger(__name__)


@router.get(
    "/{conversation_id}/input-files",
    response_model=InputFilesOut,
    summary="Internal: a conversation's uploads, as the agent's input folder lists them",
)
async def listInputFiles(
    conversation_id: str,
    user_id: str = Query(min_length=1),
    db: AsyncSession = Depends(get_db),
) -> InputFilesOut:
    set_context(user_id=user_id, conversation_id=conversation_id)
    if not await conversation_is_owned(db, conversation_id, user_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Conversation not found.")
    files = await list_input_files(db, conversation_id, user_id)
    logger.info("input_files_listed", "Listed a conversation's uploads for the agent", files=len(files))
    return InputFilesOut.model_validate({"files": files})


@router.get(
    "/{conversation_id}/input-files/{attachment_id}",
    summary="Internal: one upload's bytes (at most the 25 MB upload cap, so sent whole)",
)
async def readInputFile(
    conversation_id: str,
    attachment_id: str,
    user_id: str = Query(min_length=1),
    db: AsyncSession = Depends(get_db),
) -> Response:
    set_context(user_id=user_id, conversation_id=conversation_id)
    data = await read_input_file(db, conversation_id, user_id, attachment_id)
    if data is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Upload not found.")
    return Response(content=data, media_type="application/octet-stream")


@router.post(
    "/{conversation_id}/interjection/claim",
    response_model=InterjectionsOut,
    responses={204: {"description": "Nothing waits for this run to read."}},
    summary="Internal: a run claims the messages the user sent while it worked (steering)",
)
async def claimInterjection(
    conversation_id: str,
    body: InterjectionClaimIn,
    db: AsyncSession = Depends(get_db),
) -> InterjectionsOut | Response:
    set_context(user_id=body.user_id, conversation_id=conversation_id)
    claimed = await claim_interjection(
        db, conversation_id=conversation_id, user_id=body.user_id, run_id=body.run_id
    )
    if not claimed:
        return Response(status_code=status.HTTP_204_NO_CONTENT)
    return InterjectionsOut(messages=claimed)
