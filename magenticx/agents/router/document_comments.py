"""Internal routes over a canvas document's comments (plan 44, Phase 4.4).

The bridge's calls, internal-caller only, under the document routes' prefix.
The document's path is a query or body field; a comment is addressed by its
id, always within the user's conversation. The handlers only map the store's
exceptions to statuses:

* :class:`InvalidDocumentPath` → 422
* :class:`InvalidComment` / :class:`CommentLimitReached` → 422
  ``{"code": "invalid_comment" | "thread_limit" | "reply_limit", "message"}``
* :class:`DocumentNotFound` / :class:`CommentNotFound` → 404

``GET /{comment_id}`` (plan 44 v2) reads one comment: the bridge confirms
that a canvas edit started from a comment names an open thread of this
conversation, on the document the edit is about.
"""
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status

from core.security.internal_trust import require_internal_caller
from utils.file_branch import FileBranch, file_branch
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
    get_document_comment,
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
async def list_comments(
    user_id: str, conversation_id: str, path: str = _PATH_QUERY, branch: FileBranch = Depends(file_branch)
) -> DocumentCommentsResponse:
    """A document's threads and replies, resolved ones included, oldest first."""
    try:
        return await list_document_comments(user_id, conversation_id, path, branch=branch)
    except InvalidDocumentPath as exc:
        raise _invalid_path() from exc


@router.post("", response_model=DocumentCommentOut, status_code=status.HTTP_201_CREATED)
async def add_comment(
    user_id: str, conversation_id: str, payload: CreateCommentRequest, branch: FileBranch = Depends(file_branch)
) -> DocumentCommentOut:
    """A new thread on a passage, or a reply to a thread."""
    try:
        return await add_document_comment(user_id, conversation_id, payload, branch=branch)
    except InvalidDocumentPath as exc:
        raise _invalid_path() from exc
    except InvalidComment as exc:
        raise _invalid(exc) from exc
    except (DocumentNotFound, CommentNotFound) as exc:
        raise _not_found() from exc


@router.get("/{comment_id}", response_model=DocumentCommentOut)
async def get_comment(
    user_id: str, conversation_id: str, comment_id: UUID, branch: FileBranch = Depends(file_branch)
) -> DocumentCommentOut:
    """One comment (a thread or a reply) of this conversation branch."""
    try:
        return await get_document_comment(user_id, conversation_id, str(comment_id), branch=branch)
    except CommentNotFound as exc:
        raise _not_found() from exc


@router.patch("/{comment_id}", response_model=DocumentCommentOut)
async def update_comment(
    user_id: str, conversation_id: str, comment_id: UUID, payload: UpdateCommentRequest,
    branch: FileBranch = Depends(file_branch),
) -> DocumentCommentOut:
    """Resolve or reopen a thread, and/or edit the user's own comment."""
    try:
        return await update_document_comment(user_id, conversation_id, str(comment_id),
                                             status=payload.status, body=payload.body, branch=branch)
    except InvalidComment as exc:
        raise _invalid(exc) from exc
    except CommentNotFound as exc:
        raise _not_found() from exc


@router.delete("/{comment_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_comment(
    user_id: str, conversation_id: str, comment_id: UUID, branch: FileBranch = Depends(file_branch)
) -> Response:
    """Delete the user's own comment; a thread goes with its replies."""
    try:
        await delete_document_comment(user_id, conversation_id, str(comment_id), branch=branch)
    except InvalidComment as exc:
        raise _invalid(exc) from exc
    except CommentNotFound as exc:
        raise _not_found() from exc
    return Response(status_code=status.HTTP_204_NO_CONTENT)
