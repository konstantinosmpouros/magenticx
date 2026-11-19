"""Internal routes over a canvas document's comments (plan 44, Phase 4.4).

The bridge's calls, internal-caller only, under the document routes' prefix.
The document's path is a query or body field; a comment is addressed by its
id, always within the user's conversation. The handlers only map the store's
exceptions to statuses:

* :class:`InvalidDocumentPath` → 422
* :class:`InvalidComment` / :class:`CommentLimitReached` → 422
  ``{"code": "invalid_comment" | "thread_limit" | "reply_limit", "message"}``
* :class:`DocumentNotFound` / :class:`CommentNotFound` → 404
"""
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status

from core.security.internal_trust import require_internal_caller
from harness.conversation_files.comments import CommentNotFound, InvalidComment
from harness.conversation_files.versions import DocumentNotFound, InvalidDocumentPath
from schema import (
    CreateCommentRequest,
    DocumentCommentOut,
    DocumentCommentsResponse,
    UpdateCommentRequest,
)
from utils.document_comments import (
    add_document_comment,
    delete_document_comment,
    list_document_comments,
    update_document_comment,
)

router = APIRouter(
    prefix="/users/{user_id}/conversations/{conversation_id}/documents/comments",
    dependencies=[Depends(require_internal_caller)],
)

_PATH_QUERY = Query(min_length=1, max_length=1024, description="The document's virtual path.")


def _invalid_path() -> HTTPException:
    return HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT,
                         "A canvas document is a .md file under /conversation/output/.")


def _invalid(exc: InvalidComment) -> HTTPException:
    # ``message`` lets the structured detail through core/error_handling.py intact.
    return HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, {"code": exc.code, "message": str(exc)})


def _not_found() -> HTTPException:
    return HTTPException(status.HTTP_404_NOT_FOUND, "No such document or comment.")


@router.get("", response_model=DocumentCommentsResponse)
async def list_comments(user_id: str, conversation_id: str, path: str = _PATH_QUERY) -> DocumentCommentsResponse:
    """A document's threads and replies, resolved ones included, oldest first."""
    try:
        return await list_document_comments(user_id, conversation_id, path)
    except InvalidDocumentPath as exc:
        raise _invalid_path() from exc


@router.post("", response_model=DocumentCommentOut, status_code=status.HTTP_201_CREATED)
async def add_comment(user_id: str, conversation_id: str, payload: CreateCommentRequest) -> DocumentCommentOut:
    """A new thread on a passage, or a reply to a thread."""
    try:
        return await add_document_comment(user_id, conversation_id, payload)
    except InvalidDocumentPath as exc:
        raise _invalid_path() from exc
    except InvalidComment as exc:
        raise _invalid(exc) from exc
    except (DocumentNotFound, CommentNotFound) as exc:
        raise _not_found() from exc


@router.patch("/{comment_id}", response_model=DocumentCommentOut)
async def update_comment(
    user_id: str, conversation_id: str, comment_id: UUID, payload: UpdateCommentRequest
) -> DocumentCommentOut:
    """Resolve or reopen a thread, and/or edit the user's own comment."""
    try:
        return await update_document_comment(user_id, conversation_id, str(comment_id),
                                             status=payload.status, body=payload.body)
    except InvalidComment as exc:
        raise _invalid(exc) from exc
    except CommentNotFound as exc:
        raise _not_found() from exc


@router.delete("/{comment_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_comment(user_id: str, conversation_id: str, comment_id: UUID) -> Response:
    """Delete the user's own comment; a thread goes with its replies."""
    try:
        await delete_document_comment(user_id, conversation_id, str(comment_id))
    except InvalidComment as exc:
        raise _invalid(exc) from exc
    except CommentNotFound as exc:
        raise _not_found() from exc
    return Response(status_code=status.HTTP_204_NO_CONTENT)
