"""Comments on a canvas document (plan 44, Phase 4.4): the browser's routes.

Beside the document routes, under ``/v1/conversations``: ``validate_userId``
binds the session to the path's user, ``validate_convId`` is the owner check
(someone else's conversation, or a "Try it" trial, is a 404 with no upstream
call), then the per-user rate limit — reads in the document-read bucket,
writes in their own document-comment bucket — and CSRF on every write. The
document's path is a query or body field; a comment is addressed by its id.
"""
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Response, status

from core.auth.session import AuthUser, require_csrf_protection
from core.database import ConversationTable
from core.logging import set_context
from core.security.rate_limit import document_comment_rate_limit, document_read_rate_limit
from schema import DocumentCommentIn, DocumentCommentOut, DocumentCommentPatchIn, DocumentCommentsOut
from schema.documents import DOCUMENT_PATH_MAX_CHARS
from utils import validate_convId, validate_userId
from utils.document_comments import (
    add_document_comment,
    delete_document_comment,
    list_document_comments,
    update_document_comment,
)

router = APIRouter()

_PATH_QUERY = Query(min_length=1, max_length=DOCUMENT_PATH_MAX_CHARS, description="The document's virtual path.")


@router.get("/{user_id}/{conversation_id}/documents/comments", response_model=DocumentCommentsOut,
            summary="List a canvas document's comments")
async def listDocumentComments(
    user_id: str,
    conversation_id: str,
    path: str = _PATH_QUERY,
    current_user: AuthUser = Depends(validate_userId),
    _rate_limited: None = Depends(document_read_rate_limit),
    current_conv: ConversationTable = Depends(validate_convId),
) -> DocumentCommentsOut:
    """Threads and replies, resolved ones included (the UI filters), oldest first."""
    set_context(user_id=user_id, conversation_id=conversation_id)
    return await list_document_comments(current_user.id, current_conv.id, path)


@router.post("/{user_id}/{conversation_id}/documents/comments", response_model=DocumentCommentOut,
             status_code=status.HTTP_201_CREATED, summary="Comment on a canvas document")
async def addDocumentComment(
    user_id: str,
    conversation_id: str,
    payload: DocumentCommentIn,
    current_user: AuthUser = Depends(validate_userId),
    _csrf: None = Depends(require_csrf_protection),
    _rate_limited: None = Depends(document_comment_rate_limit),
    current_conv: ConversationTable = Depends(validate_convId),
) -> DocumentCommentOut:
    """A new thread on a passage (``anchor``) or a reply to one (``parentId``)."""
    set_context(user_id=user_id, conversation_id=conversation_id)
    return await add_document_comment(current_user.id, current_conv.id, payload)


@router.patch("/{user_id}/{conversation_id}/documents/comments/{comment_id}", response_model=DocumentCommentOut,
              summary="Resolve, reopen or edit a canvas comment")
async def updateDocumentComment(
    user_id: str,
    conversation_id: str,
    comment_id: UUID,
    payload: DocumentCommentPatchIn,
    current_user: AuthUser = Depends(validate_userId),
    _csrf: None = Depends(require_csrf_protection),
    _rate_limited: None = Depends(document_comment_rate_limit),
    current_conv: ConversationTable = Depends(validate_convId),
) -> DocumentCommentOut:
    """``status`` on a thread (resolving sets ``resolvedBy: "user"``), ``body`` on the user's own comment."""
    set_context(user_id=user_id, conversation_id=conversation_id)
    return await update_document_comment(current_user.id, current_conv.id, str(comment_id), payload)


@router.delete("/{user_id}/{conversation_id}/documents/comments/{comment_id}",
               status_code=status.HTTP_204_NO_CONTENT, summary="Delete a canvas comment")
async def deleteDocumentComment(
    user_id: str,
    conversation_id: str,
    comment_id: UUID,
    current_user: AuthUser = Depends(validate_userId),
    _csrf: None = Depends(require_csrf_protection),
    _rate_limited: None = Depends(document_comment_rate_limit),
    current_conv: ConversationTable = Depends(validate_convId),
) -> Response:
    """The user's own comment; a thread goes with its replies."""
    set_context(user_id=user_id, conversation_id=conversation_id)
    await delete_document_comment(current_user.id, current_conv.id, str(comment_id))
    return Response(status_code=status.HTTP_204_NO_CONTENT)
