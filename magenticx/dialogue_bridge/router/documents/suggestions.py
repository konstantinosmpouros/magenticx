"""The user's pending suggestions on a canvas document (plan 44, Phase 4.6): the browser's routes.

Beside the document routes, under ``/v1/conversations``: ``validate_userId``
binds the session to the path's user, ``validate_convId`` is the owner check
(someone else's conversation, or a "Try it" trial, is a 404 with no upstream
call), then the per-user rate limit — the read in the document-read bucket,
the writes in their own document-suggestion bucket — and CSRF on every write.
One set per document, addressed by its path (a query or body field):

* ``GET    …/documents/suggestion?path=`` → 200 ``{path, baseVersion, content, updatedAt}``, or 404 ``{code: "no_suggestion"}``
* ``PUT    …/documents/suggestion`` ``{path, baseVersion, content}`` → 200 the saved set, or 204 when the proposed text equals the base
* ``DELETE …/documents/suggestion?path=`` → 204 (idempotent)

Accepting is not a route: the UI saves the accepted text with the save-version
route, then deletes (or rewrites) the set.
"""
from fastapi import APIRouter, Depends, Query, Response, status

from core.auth.session import AuthUser, require_csrf_protection
from core.database import ConversationTable
from core.logging import set_context
from core.security.rate_limit import document_read_rate_limit, document_suggestion_rate_limit
from schema import DocumentSuggestionIn, DocumentSuggestionOut
from schema.documents.documents import DOCUMENT_PATH_MAX_CHARS
from utils.validators import validate_convId, validate_userId
from engine.conversations.file_branches import FileBranch, document_branch
from engine.documents.suggestions import (
    delete_document_suggestion,
    get_document_suggestion,
    put_document_suggestion,
)

router = APIRouter()

_PATH_QUERY = Query(min_length=1, max_length=DOCUMENT_PATH_MAX_CHARS, description="The document's virtual path.")
_ROUTE = "/{user_id}/{conversation_id}/documents/suggestion"


@router.get(_ROUTE, response_model=DocumentSuggestionOut, summary="Read a canvas document's pending suggestions",
            responses={404: {"description": "no_suggestion — the document has nothing pending"}})
async def getDocumentSuggestion(
    user_id: str,
    conversation_id: str,
    path: str = _PATH_QUERY,
    current_user: AuthUser = Depends(validate_userId),
    _rate_limited: None = Depends(document_read_rate_limit),
    current_conv: ConversationTable = Depends(validate_convId),
    branch: FileBranch = Depends(document_branch),
) -> DocumentSuggestionOut:
    """The proposed text and the version it was made on."""
    set_context(user_id=user_id, conversation_id=conversation_id)
    return await get_document_suggestion(current_user.id, current_conv.id, path, branch=branch)


@router.put(_ROUTE, response_model=DocumentSuggestionOut, summary="Save a canvas document's pending suggestions",
            responses={204: {"description": "The proposed text equals the base: the set was cleared."}})
async def putDocumentSuggestion(
    user_id: str,
    conversation_id: str,
    payload: DocumentSuggestionIn,
    current_user: AuthUser = Depends(validate_userId),
    _csrf: None = Depends(require_csrf_protection),
    _rate_limited: None = Depends(document_suggestion_rate_limit),
    current_conv: ConversationTable = Depends(validate_convId),
    branch: FileBranch = Depends(document_branch),
) -> DocumentSuggestionOut | Response:
    """The whole pending set (proposed text on ``baseVersion``) replaces the stored one."""
    set_context(user_id=user_id, conversation_id=conversation_id)
    saved = await put_document_suggestion(current_user.id, current_conv.id, payload, branch=branch)
    if saved is None:
        return Response(status_code=status.HTTP_204_NO_CONTENT)
    return saved


@router.delete(_ROUTE, status_code=status.HTTP_204_NO_CONTENT, summary="Drop a canvas document's pending suggestions")
async def deleteDocumentSuggestion(
    user_id: str,
    conversation_id: str,
    path: str = _PATH_QUERY,
    current_user: AuthUser = Depends(validate_userId),
    _csrf: None = Depends(require_csrf_protection),
    _rate_limited: None = Depends(document_suggestion_rate_limit),
    current_conv: ConversationTable = Depends(validate_convId),
    branch: FileBranch = Depends(document_branch),
) -> Response:
    """Reject all, or the tail of an accept — never a new version."""
    set_context(user_id=user_id, conversation_id=conversation_id)
    await delete_document_suggestion(current_user.id, current_conv.id, path, branch=branch)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
