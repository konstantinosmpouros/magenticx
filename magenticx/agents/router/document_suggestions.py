"""Internal routes over a canvas document's pending suggestions (plan 44, Phase 4.6).

The bridge's calls, internal-caller only, under the document routes' prefix,
keyed by user and conversation. The document's path is a query or body
field. One set per document, so the routes address it by path alone:

* ``GET    …/documents/suggestion?path=`` → 200 the set, or 404 ``{"code": "no_suggestion", "message"}``
* ``PUT    …/documents/suggestion`` → 200 the saved set, or 204 when the
  proposed text equals the base version's (the set is cleared)
* ``DELETE …/documents/suggestion?path=`` → 204, idempotent

The handlers only map the store's exceptions: an invalid path or an
over-size text → 422; a base version the conversation's document does not
have → 404 (no code: the document, not the set, is missing).
"""
from fastapi import APIRouter, Depends, HTTPException, Query, Response, status

from core.security.internal_trust import require_internal_caller
from utils.file_branch import FileBranch, file_branch
from harness.conversation_files.versions import DocumentNotFound, DocumentTooLarge, InvalidDocumentPath
from schema import DocumentSuggestionOut, PutDocumentSuggestionRequest
from utils.document_suggestions import (
    delete_document_suggestion,
    get_document_suggestion,
    put_document_suggestion,
)

router = APIRouter(
    prefix="/users/{user_id}/conversations/{conversation_id}/documents/suggestion",
    dependencies=[Depends(require_internal_caller)],
)

_PATH_QUERY = Query(min_length=1, max_length=1024, description="The document's virtual path.")


def _invalid(exc: Exception) -> HTTPException:
    if isinstance(exc, DocumentTooLarge):
        return HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "The suggested text is over 1 MiB.")
    return HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT,
                         "A canvas document is a .md file under /conversation/output/.")


@router.get("", response_model=DocumentSuggestionOut)
async def read_document_suggestion(
    user_id: str, conversation_id: str, path: str = _PATH_QUERY, branch: FileBranch = Depends(file_branch)
) -> DocumentSuggestionOut:
    """The document's pending set; 404 ``no_suggestion`` when it has none."""
    try:
        found = await get_document_suggestion(user_id, conversation_id, path, branch=branch)
    except InvalidDocumentPath as exc:
        raise _invalid(exc) from exc
    if found is None:
        # ``message`` lets the structured detail through core/error_handling.py intact.
        raise HTTPException(status.HTTP_404_NOT_FOUND,
                            {"code": "no_suggestion", "message": "The document has no pending suggestions."})
    return found


@router.put("", response_model=DocumentSuggestionOut,
            responses={204: {"description": "The proposed text equals the base: the set was cleared."}})
async def save_document_suggestion(
    user_id: str, conversation_id: str, payload: PutDocumentSuggestionRequest,
    branch: FileBranch = Depends(file_branch),
) -> DocumentSuggestionOut | Response:
    """Save the pending set (an upsert); 204 when nothing is suggested any more."""
    try:
        saved = await put_document_suggestion(
            user_id, conversation_id, payload.path, payload.base_version, payload.content, branch=branch)
    except (InvalidDocumentPath, DocumentTooLarge) as exc:
        raise _invalid(exc) from exc
    except DocumentNotFound as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such document version.") from exc
    if saved is None:
        return Response(status_code=status.HTTP_204_NO_CONTENT)
    return saved


@router.delete("", status_code=status.HTTP_204_NO_CONTENT)
async def drop_document_suggestion(
    user_id: str, conversation_id: str, path: str = _PATH_QUERY, branch: FileBranch = Depends(file_branch)
) -> Response:
    """Drop the pending set — reject all, or after the accepted text was saved. Idempotent."""
    try:
        await delete_document_suggestion(user_id, conversation_id, path, branch=branch)
    except InvalidDocumentPath as exc:
        raise _invalid(exc) from exc
    return Response(status_code=status.HTTP_204_NO_CONTENT)
