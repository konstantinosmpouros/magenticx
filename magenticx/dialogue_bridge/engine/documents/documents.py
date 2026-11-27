"""A conversation's canvas documents, passed through from the agents service (plan 44, Phase 4.1).

The agents service owns the versions (``agent_runtime.conversation_file_versions``);
the bridge adds what only it can: the conversation-owner check (done by the
route's ``validate_convId`` before anything here runs), the per-user rate
limits, CSRF on the save, and validation both ways. Every upstream body is
validated against ``schema/documents/documents.py`` before it reaches the browser; a body
that does not match is a 502, never forwarded.

Upstream statuses the UI acts on are kept: 404 (no such document or version),
422 (not a canvas path, or over the size cap) and the save's 409, whose detail
(the latest version and its text) is re-validated and passed through. Anything
else is a 502; an unreachable agents service a 503. Logs carry the operation
and status only — a path or a document's text can hold the user's words.
"""
from __future__ import annotations

from typing import Any, NoReturn

import httpx
from fastapi import HTTPException, status
from pydantic import BaseModel, ValidationError

from core.error_handling import upstream_error_handler
from core.logging import get_context, get_logger
from core.security.internal_trust import internal_service_headers
from core.security.tls import get_httpx_client_cert, get_httpx_verify
from core.settings import settings
from schema import (
    DocumentListOut,
    DocumentSaveIn,
    DocumentSaveOut,
    DocumentStaleBaseDetail,
    DocumentVersionOut,
    DocumentVersionsOut,
)
from engine.agents.service_urls import build_conversation_documents_url
from engine.conversations.file_branches import FileBranch

logger = get_logger(__name__)

#: Public messages for the statuses kept from upstream.
_NOT_FOUND = "Document not found."
_INVALID = "That is not a document this conversation can open or save."
_UNAVAILABLE = "Documents are temporarily unavailable. Please try again shortly."
_FAILED = "The document could not be loaded. Please try again."


def _stale_base(response: httpx.Response) -> NoReturn:
    """The save's 409, its detail re-validated: the latest version and its text."""
    try:
        detail = DocumentStaleBaseDetail.model_validate(response.json().get("detail"))
    except (ValueError, AttributeError, ValidationError) as exc:
        upstream_error_handler.raise_invalid_response(
            logger, exc,
            event="document_conflict_invalid_payload",
            message="Agents service returned a malformed document conflict",
            public_detail=_FAILED, upstream_service="agents", operation="document_save",
        )
    raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=detail.model_dump())


async def _call[Model: BaseModel](
    method: str, url: str, model: type[Model], *, operation: str,
    params: dict[str, Any] | None = None, json_body: dict[str, Any] | None = None,
) -> Model:
    """One call to the agents service's document routes, validated into ``model``.

    No retry: a save is not idempotent from the caller's side (a retried save
    whose first attempt landed would come back as a 409 against itself), and
    a read is cheap to repeat from the UI.
    """
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
            message="Failed to reach the agents service for a document call",
            public_detail=_UNAVAILABLE, upstream_service="agents", operation=operation,
        )
    if response.status_code == status.HTTP_404_NOT_FOUND:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=_NOT_FOUND)
    if response.status_code == status.HTTP_422_UNPROCESSABLE_CONTENT:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=_INVALID)
    if response.status_code == status.HTTP_409_CONFLICT and operation == "document_save":
        _stale_base(response)
    try:
        response.raise_for_status()
    except httpx.HTTPStatusError as exc:
        upstream_error_handler.raise_http_error(
            logger, exc,
            event=f"{operation}_failed",
            message="Agents service returned an HTTP error for a document call",
            public_detail=_FAILED, upstream_service="agents", operation=operation,
        )
    try:
        return model.model_validate(response.json())
    except (ValueError, ValidationError) as exc:
        upstream_error_handler.raise_invalid_response(
            logger, exc,
            event=f"{operation}_invalid_payload",
            message="Agents service returned a malformed document payload",
            public_detail=_FAILED, upstream_service="agents", operation=operation,
        )


async def list_documents(user_id: str, conversation_id: str, limit: int, *, branch: FileBranch) -> DocumentListOut:
    """The branch's documents at their latest version, newest first."""
    return await _call("GET", build_conversation_documents_url(user_id, conversation_id), DocumentListOut,
                       operation="document_list", params={**branch.params(), "limit": limit})


async def latest_document(user_id: str, conversation_id: str, path: str, *, branch: FileBranch) -> DocumentVersionOut:
    """A document's latest version on the branch, with its text."""
    return await _call("GET", f"{build_conversation_documents_url(user_id, conversation_id)}/latest",
                       DocumentVersionOut, operation="document_latest", params={**branch.params(), "path": path})


async def list_document_versions(
    user_id: str, conversation_id: str, path: str, limit: int, *, branch: FileBranch
) -> DocumentVersionsOut:
    """A document's history on the branch without text, newest first."""
    return await _call("GET", f"{build_conversation_documents_url(user_id, conversation_id)}/versions",
                       DocumentVersionsOut, operation="document_versions",
                       params={**branch.params(), "path": path, "limit": limit})


async def get_document_version(
    user_id: str, conversation_id: str, path: str, version: int, *, branch: FileBranch
) -> DocumentVersionOut:
    """One version of a document on the branch, with its text."""
    return await _call("GET", f"{build_conversation_documents_url(user_id, conversation_id)}/versions/{version}",
                       DocumentVersionOut, operation="document_version", params={**branch.params(), "path": path})


async def save_document_version(
    user_id: str, conversation_id: str, payload: DocumentSaveIn, *, branch: FileBranch
) -> DocumentSaveOut:
    """The user's save as the next version on the branch; a 409 carries the latest version and its text."""
    saved = await _call("POST", f"{build_conversation_documents_url(user_id, conversation_id)}/versions",
                        DocumentSaveOut, operation="document_save", params=branch.params(),
                        json_body=payload.model_dump())
    logger.info("document_version_saved", "Saved a version of a canvas document",
                conversation_id=conversation_id, version=saved.version)
    return saved
