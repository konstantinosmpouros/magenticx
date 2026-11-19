"""What the bridge asks of a canvas document's comments (plan 44, Phase 4.4).

Thin over :class:`~harness.conversation_files.DocumentCommentStore`: the path
is validated into its canonical form first (:func:`document_path` — a 422
before any SQL), and the store's comments are shaped into the response
schemas. The routes in ``router/document_comments.py`` map the store's
exceptions to statuses. Logs carry counts only — a comment is the user's text.
"""
from __future__ import annotations

from harness.conversation_files import DocumentCommentStore
from harness.conversation_files.comments import CommentAnchor, CommentStatus, DocumentComment
from harness.conversation_files.versions import document_path
from harness.memory import get_memory_pool
from schema import (
    CommentAnchorModel,
    CreateCommentRequest,
    DocumentCommentOut,
    DocumentCommentsResponse,
)


def _store() -> DocumentCommentStore:
    return DocumentCommentStore(get_memory_pool())


def _out(comment: DocumentComment) -> DocumentCommentOut:
    anchor = comment.anchor
    return DocumentCommentOut(
        id=comment.id,
        path=comment.path,
        version=comment.version,
        parent_id=comment.parent_id,
        anchor=CommentAnchorModel(quote=anchor.quote, prefix=anchor.prefix, suffix=anchor.suffix)
        if anchor is not None else None,
        body=comment.body,
        author=comment.author,
        status=comment.status,
        resolved_by=comment.resolved_by,
        resolution_note=comment.resolution_note,
        created_at=comment.created_at,
        updated_at=comment.updated_at,
    )


async def list_document_comments(user_id: str, conversation_id: str, path: str) -> DocumentCommentsResponse:
    """A document's threads and replies, resolved ones included, oldest first."""
    canonical = document_path(path)
    comments = await _store().list_comments(user_id, conversation_id, canonical)
    return DocumentCommentsResponse(comments=[_out(c) for c in comments])


async def get_document_comment(user_id: str, conversation_id: str, comment_id: str) -> DocumentCommentOut:
    """One comment of this conversation — the bridge's check of a comment-started canvas edit (plan 44 v2)."""
    return _out(await _store().get_comment(user_id, conversation_id, comment_id))


async def add_document_comment(
    user_id: str, conversation_id: str, payload: CreateCommentRequest
) -> DocumentCommentOut:
    """The user's new thread or reply."""
    canonical = document_path(payload.path)
    anchor = payload.anchor
    comment = await _store().add_comment(
        user_id, conversation_id, canonical,
        version=payload.version,
        body=payload.body,
        anchor=CommentAnchor(quote=anchor.quote, prefix=anchor.prefix, suffix=anchor.suffix)
        if anchor is not None else None,
        parent_id=str(payload.parent_id) if payload.parent_id is not None else None,
    )
    return _out(comment)


async def update_document_comment(
    user_id: str, conversation_id: str, comment_id: str, *, status: CommentStatus | None, body: str | None
) -> DocumentCommentOut:
    """Resolve / reopen a thread, or edit the user's own comment."""
    return _out(await _store().update_comment(user_id, conversation_id, comment_id, status=status, body=body))


async def delete_document_comment(user_id: str, conversation_id: str, comment_id: str) -> None:
    """Delete the user's own comment (a thread with its replies)."""
    await _store().delete_comment(user_id, conversation_id, comment_id)
