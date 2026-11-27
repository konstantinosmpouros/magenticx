"""Comments on a canvas document, passed through from the agents service (plan 44, Phase 4.4).

The agents service owns the comments; the bridge adds the conversation-owner
check (the route's ``validate_convId``, before anything here runs), CSRF on
the writes, the per-user rate limits and validation both ways: the camelCase
request becomes the agents service's snake_case body, and every upstream body
is re-validated (``schema/documents/comments.py``) — a malformed one is a 502.

Kept from upstream: 404 (no such document, version or comment in this
conversation) and 422, whose ``{code, message}`` detail passes through when it
is one of the known refusals (``invalid_comment``, ``thread_limit``,
``reply_limit``); any other 422 becomes a generic one. Anything else is a 502,
an unreachable agents service a 503. No retry: a retried add whose first
attempt landed would add the comment twice. Logs carry the operation and
status only — a comment is the user's text.
"""
from __future__ import annotations

from typing import Any

import httpx
from fastapi import HTTPException, status
from pydantic import ValidationError

from core.error_handling import upstream_error_handler
from core.logging import get_context, get_logger
from core.security.internal_trust import internal_service_headers
from core.security.tls import get_httpx_client_cert, get_httpx_verify
from core.settings import settings
from schema import (
    DocumentCommentIn,
    DocumentCommentOut,
    DocumentCommentPatchIn,
    DocumentCommentRefusal,
    DocumentCommentsOut,
)
from engine.agents.service_urls import build_conversation_documents_url
from engine.conversations.file_branches import FileBranch

logger = get_logger(__name__)

_NOT_FOUND = "That document or comment is not in this conversation."
_INVALID = "That comment cannot be saved."
_UNAVAILABLE = "Comments are temporarily unavailable. Please try again shortly."
_FAILED = "The comments could not be loaded. Please try again."


def _comments_url(user_id: str, conversation_id: str) -> str:
    return f"{build_conversation_documents_url(user_id, conversation_id)}/comments"


def _refusal(response: httpx.Response) -> Any:
    """The 422's detail when it is a known refusal, else the generic message."""
    try:
        return DocumentCommentRefusal.model_validate(response.json().get("detail")).model_dump()
    except (ValueError, AttributeError, ValidationError):
        return _INVALID


async def _request(
    method: str, url: str, *, operation: str,
    params: dict[str, Any] | None = None, json_body: dict[str, Any] | None = None,
) -> httpx.Response:
    """One call to the agents service's comment routes; upstream errors mapped as the docstring says."""
    try:
        async with httpx.AsyncClient(
            timeout=settings.http.agents_timeout, verify=get_httpx_verify(), cert=get_httpx_client_cert()
        ) as client:
            response = await client.request(
                method, url, params=params, json=json_body,
                headers=internal_service_headers(get_context().get("request_id")),
            )
    except httpx.RequestError as exc:
        upstream_error_handler.raise_request_error(
            logger, exc,
            event=f"{operation}_unreachable",
            message="Failed to reach the agents service for a document comment call",
            public_detail=_UNAVAILABLE, upstream_service="agents", operation=operation,
        )
    if response.status_code == status.HTTP_404_NOT_FOUND:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=_NOT_FOUND)
    if response.status_code == status.HTTP_422_UNPROCESSABLE_CONTENT:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=_refusal(response))
    try:
        response.raise_for_status()
    except httpx.HTTPStatusError as exc:
        upstream_error_handler.raise_http_error(
            logger, exc,
            event=f"{operation}_failed",
            message="Agents service returned an HTTP error for a document comment call",
            public_detail=_FAILED, upstream_service="agents", operation=operation,
        )
    return response


def _validated[Model: DocumentCommentOut | DocumentCommentsOut](
    response: httpx.Response, model: type[Model], *, operation: str
) -> Model:
    try:
        return model.model_validate(response.json())
    except (ValueError, ValidationError) as exc:
        upstream_error_handler.raise_invalid_response(
            logger, exc,
            event=f"{operation}_invalid_payload",
            message="Agents service returned a malformed document comment payload",
            public_detail=_FAILED, upstream_service="agents", operation=operation,
        )


async def list_document_comments(
    user_id: str, conversation_id: str, path: str, *, branch: FileBranch
) -> DocumentCommentsOut:
    """A document's threads and replies on the branch, oldest first."""
    response = await _request("GET", _comments_url(user_id, conversation_id), operation="document_comments",
                              params={**branch.params(), "path": path})
    return _validated(response, DocumentCommentsOut, operation="document_comments")


async def get_document_comment(
    user_id: str, conversation_id: str, comment_id: str, *, branch: FileBranch
) -> DocumentCommentOut:
    """One comment of the conversation's branch (a 404 when it has none with that id).

    Used by the canvas-edit check (plan 44 v2) to confirm the thread a
    comment-started edit names.
    """
    response = await _request("GET", f"{_comments_url(user_id, conversation_id)}/{comment_id}",
                              operation="document_comment_get", params=branch.params())
    return _validated(response, DocumentCommentOut, operation="document_comment_get")


async def add_document_comment(
    user_id: str, conversation_id: str, payload: DocumentCommentIn, *, branch: FileBranch
) -> DocumentCommentOut:
    """The user's new thread or reply."""
    response = await _request("POST", _comments_url(user_id, conversation_id), operation="document_comment_add",
                              params=branch.params(), json_body=payload.upstream())
    comment = _validated(response, DocumentCommentOut, operation="document_comment_add")
    logger.info("document_comment_added", "Added a comment to a canvas document",
                conversation_id=conversation_id, reply=comment.parentId is not None)
    return comment


async def update_document_comment(
    user_id: str, conversation_id: str, comment_id: str, payload: DocumentCommentPatchIn, *, branch: FileBranch
) -> DocumentCommentOut:
    """Resolve / reopen a thread, or edit the user's own comment."""
    response = await _request("PATCH", f"{_comments_url(user_id, conversation_id)}/{comment_id}",
                              operation="document_comment_update", params=branch.params(),
                              json_body=payload.model_dump(exclude_none=True))
    return _validated(response, DocumentCommentOut, operation="document_comment_update")


async def delete_document_comment(
    user_id: str, conversation_id: str, comment_id: str, *, branch: FileBranch
) -> None:
    """Delete the user's own comment; a thread goes with its replies."""
    await _request("DELETE", f"{_comments_url(user_id, conversation_id)}/{comment_id}",
                   operation="document_comment_delete", params=branch.params())
    logger.info("document_comment_deleted", "Deleted a comment from a canvas document",
                conversation_id=conversation_id)
