"""The user's pending suggestions on a canvas document, passed through from the agents service (plan 44, 4.6).

The agents service owns the sets; the bridge adds the conversation-owner check
(the route's ``validate_convId``, before anything here runs), CSRF on the
writes, the per-user rate limits and validation both ways: the camelCase
request becomes the agents service's snake_case body, and every upstream body
is re-validated (``schema/document_suggestions.py``) — a malformed one is a 502.

Kept from upstream: the GET's 404 ``{code: "no_suggestion"}`` (passed through,
so the canvas knows the document simply has nothing pending), any other 404
(no such document or base version) as a generic 404, a 422 (not a canvas
path, or over the size cap) as a generic 422, and the PUT's 204 (the proposed
text equals the base: the set was cleared). Anything else is a 502; an
unreachable agents service a 503. No retry — a PUT and a DELETE are
idempotent, but the UI repeats them cheaply and a retry would only double the
latency of a real outage. Logs carry the operation and outcome only — a path
or a suggested text is the user's words.
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
from schema import DocumentSuggestionIn, DocumentSuggestionOut
from utils.agents import build_conversation_documents_url

logger = get_logger(__name__)

_NO_SUGGESTION = {"code": "no_suggestion", "message": "The document has no pending suggestions."}
_NOT_FOUND = "Document not found."
_INVALID = "Those suggestions cannot be saved on this document."
_UNAVAILABLE = "Suggestions are temporarily unavailable. Please try again shortly."
_FAILED = "The suggestions could not be loaded. Please try again."


def _suggestion_url(user_id: str, conversation_id: str) -> str:
    return f"{build_conversation_documents_url(user_id, conversation_id)}/suggestion"


def _is_no_suggestion(response: httpx.Response) -> bool:
    """Whether a 404 is the agents service's "this document has nothing pending"."""
    try:
        detail = response.json().get("detail")
    except (ValueError, AttributeError):
        return False
    return isinstance(detail, dict) and detail.get("code") == "no_suggestion"


async def _request(
    method: str, url: str, *, operation: str,
    params: dict[str, Any] | None = None, json_body: dict[str, Any] | None = None,
) -> httpx.Response:
    """One call to the agents service's suggestion route; upstream errors mapped as the docstring says."""
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
            message="Failed to reach the agents service for a document suggestion call",
            public_detail=_UNAVAILABLE, upstream_service="agents", operation=operation,
        )
    if response.status_code == status.HTTP_404_NOT_FOUND:
        detail = _NO_SUGGESTION if _is_no_suggestion(response) else _NOT_FOUND
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=detail)
    if response.status_code == status.HTTP_422_UNPROCESSABLE_CONTENT:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=_INVALID)
    try:
        response.raise_for_status()
    except httpx.HTTPStatusError as exc:
        upstream_error_handler.raise_http_error(
            logger, exc,
            event=f"{operation}_failed",
            message="Agents service returned an HTTP error for a document suggestion call",
            public_detail=_FAILED, upstream_service="agents", operation=operation,
        )
    return response


def _validated(response: httpx.Response, *, operation: str) -> DocumentSuggestionOut:
    try:
        return DocumentSuggestionOut.model_validate(response.json())
    except (ValueError, ValidationError) as exc:
        upstream_error_handler.raise_invalid_response(
            logger, exc,
            event=f"{operation}_invalid_payload",
            message="Agents service returned a malformed document suggestion payload",
            public_detail=_FAILED, upstream_service="agents", operation=operation,
        )


async def get_document_suggestion(user_id: str, conversation_id: str, path: str) -> DocumentSuggestionOut:
    """The document's pending set; a 404 ``no_suggestion`` when it has none."""
    response = await _request("GET", _suggestion_url(user_id, conversation_id), operation="document_suggestion_get",
                              params={"path": path})
    return _validated(response, operation="document_suggestion_get")


async def put_document_suggestion(
    user_id: str, conversation_id: str, payload: DocumentSuggestionIn
) -> DocumentSuggestionOut | None:
    """Save the pending set; None when the agents service cleared it (the proposed text equals the base)."""
    response = await _request("PUT", _suggestion_url(user_id, conversation_id), operation="document_suggestion_put",
                              json_body=payload.upstream())
    if response.status_code == status.HTTP_204_NO_CONTENT:
        logger.info("document_suggestion_cleared", "Cleared the pending suggestions on a canvas document",
                    conversation_id=conversation_id)
        return None
    saved = _validated(response, operation="document_suggestion_put")
    logger.info("document_suggestion_saved", "Saved the pending suggestions on a canvas document",
                conversation_id=conversation_id, base_version=saved.baseVersion)
    return saved


async def delete_document_suggestion(user_id: str, conversation_id: str, path: str) -> None:
    """Drop the pending set (idempotent upstream)."""
    await _request("DELETE", _suggestion_url(user_id, conversation_id), operation="document_suggestion_delete",
                   params={"path": path})
    logger.info("document_suggestion_deleted", "Dropped the pending suggestions on a canvas document",
                conversation_id=conversation_id)
