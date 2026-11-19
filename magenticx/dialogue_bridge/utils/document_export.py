"""Export a canvas document, and preview an Office attachment as a PDF (plan 44, Phase 4.5).

Both are rendered by the agents service in the sandbox box (pandoc,
LibreOffice; a fixed command, never the model's). The bridge adds what only it
can: the owner checks (``validate_convId`` on the export route; the
attachment → message → conversation → user join here for the preview), the
per-user rate limits, the PDF cache beside the attachment, and a strict check
of what comes back before the browser sees it.

Errors the UI acts on carry a structured body, returned as a ``JSONResponse``
because the service's exception handler keeps a structured ``detail`` for 4xx
only:

* ``503 {"detail": {"code": "sandbox_unavailable", "message"}}`` — the box
  cannot run (execution off, no runner, runner down or busy). The preview's
  UI falls back to its old viewer on it.
* ``504 {"detail": {"code": "conversion_timeout", "message"}}``
* ``502 {"detail": {"code": "conversion_failed", "message"}}`` — it ran but
  produced nothing usable (e.g. a corrupt Office file).

An unreachable agents service is the usual plain ``503``. Logs carry formats,
sizes and statuses — never a path, a file name or content.
"""
from __future__ import annotations

import hashlib
import unicodedata
from urllib.parse import quote, unquote

import httpx
from fastapi import HTTPException, Response, status
from fastapi.responses import JSONResponse
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from core.database import (
    AttachmentPdfPreviewTable,
    AttachmentTable,
    BlobTable,
    ConversationTable,
    MessageTable,
)
from core.error_handling import upstream_error_handler
from core.logging import get_context, get_logger
from core.security.internal_trust import internal_service_headers
from core.security.tls import get_httpx_client_cert, get_httpx_verify
from core.settings import settings
from schema import DocumentExportIn
from utils.agents import build_conversation_documents_url, build_conversation_office_preview_url

logger = get_logger(__name__)

EXPORT_MEDIA_TYPES: dict[str, str] = {
    "md": "text/markdown; charset=utf-8",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "pdf": "application/pdf",
}

#: Office files previewed as a PDF, by extension, with the MIME types an
#: upload of each may carry (the stored MIME is the browser's word, so the
#: extension decides first — as the UI routes previews).
OFFICE_PDF_PREVIEW_MIME_BY_EXT: dict[str, str] = {
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "odt": "application/vnd.oasis.opendocument.text",
    "ods": "application/vnd.oasis.opendocument.spreadsheet",
    "odp": "application/vnd.oasis.opendocument.presentation",
}
_EXT_BY_MIME = {mime: ext for ext, mime in OFFICE_PDF_PREVIEW_MIME_BY_EXT.items()}

#: The agents service names the export in this header, percent-encoded UTF-8.
FILENAME_HEADER = "X-Export-Filename"
#: Longest download name accepted from upstream (characters).
_MAX_FILENAME_CHARS = 120
# What a download's name may hold besides letters (any script) and digits —
# the agents service's own rule; anything else falls back to "document".
_FILENAME_PUNCTUATION = frozenset(" -_.,()&+")

_UNAVAILABLE = "Documents are temporarily unavailable. Please try again shortly."
_FAILED = "The file could not be prepared. Please try again."


def sandbox_error(status_code: int, code: str, message: str) -> JSONResponse:
    """One of the structured 5xx bodies the UI reads (module docstring)."""
    return JSONResponse(status_code=status_code, content={"detail": {"code": code, "message": message}})


_SANDBOX_UNAVAILABLE = (status.HTTP_503_SERVICE_UNAVAILABLE, "sandbox_unavailable",
                        "Converting files is not available right now.")
_CONVERSION_TIMEOUT = (status.HTTP_504_GATEWAY_TIMEOUT, "conversion_timeout",
                       "The conversion took too long. Please try again.")
_CONVERSION_FAILED = (status.HTTP_502_BAD_GATEWAY, "conversion_failed",
                      "The file could not be converted.")


def _safe_download_name(header: str | None, fmt: str) -> str:
    """The upstream name if it is a plain ``<title>.<fmt>``, else ``document.<fmt>``.

    The agents service already cut the title down; this is the second line, so
    a quote, a slash or a control character can never reach the header.
    """
    fallback = f"document.{fmt}"
    if not header:
        return fallback
    name = unicodedata.normalize("NFC", unquote(header))
    if len(name) > _MAX_FILENAME_CHARS or not name.endswith(f".{fmt}") or name.startswith("."):
        return fallback
    for ch in name:
        if unicodedata.category(ch)[0] not in ("L", "N") and ch not in _FILENAME_PUNCTUATION:
            return fallback
    return name


def content_disposition(name: str, disposition: str, fmt: str) -> str:
    """``<disposition>; filename="<ascii>"; filename*=UTF-8''<name>``. The
    plain ``filename`` is for old clients: the name itself when it is ASCII,
    ``document.<fmt>`` otherwise (a Greek title would come out empty)."""
    ascii_name = name if name.isascii() else f"document.{fmt}"
    return f"{disposition}; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(name, safe='')}"


def _conversion_failure(response: httpx.Response) -> Response | None:
    """The box's outcomes as the structured bodies; None for anything else."""
    if response.status_code == status.HTTP_503_SERVICE_UNAVAILABLE:
        return sandbox_error(*_SANDBOX_UNAVAILABLE)
    if response.status_code == status.HTTP_504_GATEWAY_TIMEOUT:
        return sandbox_error(*_CONVERSION_TIMEOUT)
    if response.status_code == status.HTTP_502_BAD_GATEWAY:
        return sandbox_error(*_CONVERSION_FAILED)
    return None


async def _post(url: str, *, operation: str, **request: object) -> httpx.Response:
    """One call to the agents service with the conversion's longer timeout."""
    try:
        async with httpx.AsyncClient(
            timeout=settings.http.conversion_timeout, verify=get_httpx_verify(), cert=get_httpx_client_cert()
        ) as client:
            return await client.post(
                url, headers=internal_service_headers(get_context().get("request_id")), **request
            )
    except httpx.RequestError as exc:
        upstream_error_handler.raise_request_error(
            logger, exc,
            event=f"{operation}_unreachable",
            message="Failed to reach the agents service for a conversion",
            public_detail=_UNAVAILABLE, upstream_service="agents", operation=operation,
        )


def _raise_unexpected(response: httpx.Response, operation: str) -> None:
    """Any status not handled above → the usual 502."""
    try:
        response.raise_for_status()
    except httpx.HTTPStatusError as exc:
        upstream_error_handler.raise_http_error(
            logger, exc,
            event=f"{operation}_failed",
            message="Agents service returned an HTTP error for a conversion",
            public_detail=_FAILED, upstream_service="agents", operation=operation,
        )


def _bad_payload(operation: str, reason: str) -> JSONResponse:
    logger.warning(f"{operation}_invalid_payload", "Agents service returned an unusable converted file",
                   failure_reason=reason)
    return sandbox_error(*_CONVERSION_FAILED)


# ---------------------------------------------------------------------------
# Export
# ---------------------------------------------------------------------------
async def export_document(user_id: str, conversation_id: str, payload: DocumentExportIn) -> Response:
    """The document version as a download, or the error the UI acts on."""
    operation = "document_export"
    fmt = payload.format
    response = await _post(f"{build_conversation_documents_url(user_id, conversation_id)}/export",
                           operation=operation, json=payload.model_dump())
    if response.status_code == status.HTTP_404_NOT_FOUND:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Document not found.")
    if response.status_code == status.HTTP_422_UNPROCESSABLE_CONTENT:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "That is not a document this conversation can export.")
    failure = _conversion_failure(response)
    if failure is not None:
        logger.warning("document_export_unavailable", "A document export could not run in the sandbox",
                       format=fmt, status_code=response.status_code)
        return failure
    _raise_unexpected(response, operation)

    content = response.content
    upstream_type = response.headers.get("content-type", "").split(";")[0].strip().lower()
    if upstream_type != EXPORT_MEDIA_TYPES[fmt].split(";")[0]:
        return _bad_payload(operation, "content_type")
    if not content or len(content) > settings.attachments.pdf_preview_max_bytes:
        return _bad_payload(operation, "size")
    name = _safe_download_name(response.headers.get(FILENAME_HEADER), fmt)
    logger.info("document_export_served", "Served a canvas document export", format=fmt, size_bytes=len(content))
    return Response(
        content=content,
        media_type=EXPORT_MEDIA_TYPES[fmt],
        headers={
            "Content-Disposition": content_disposition(name, "attachment", fmt),
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "no-store",
        },
    )


# ---------------------------------------------------------------------------
# Office PDF preview
# ---------------------------------------------------------------------------
def office_extension(file_name: str | None, mime_type: str | None) -> str | None:
    """The previewable Office type of an attachment: by extension first, then
    by a canonical stored MIME; None when it is not one."""
    name = file_name or ""
    ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    if ext in OFFICE_PDF_PREVIEW_MIME_BY_EXT:
        return ext
    return _EXT_BY_MIME.get((mime_type or "").split(";")[0].strip().lower())


async def _owned_attachment(db: AsyncSession, user_id: str, attachment_id: str):
    """The attachment's metadata when ``user_id`` owns its conversation — the
    same join as the download route's owner check; 404 otherwise."""
    result = await db.execute(
        select(
            AttachmentTable.id,
            AttachmentTable.file_name,
            AttachmentTable.mime_type,
            AttachmentTable.content_sha256,
            AttachmentTable.blob_id,
            MessageTable.conversation_id,
            func.coalesce(AttachmentTable.size_bytes, func.length(BlobTable.data)).label("size"),
        )
        .select_from(AttachmentTable)
        .join(BlobTable, BlobTable.id == AttachmentTable.blob_id)
        .join(MessageTable, MessageTable.id == AttachmentTable.message_id)
        .join(ConversationTable, ConversationTable.id == MessageTable.conversation_id)
        .where(AttachmentTable.id == attachment_id, ConversationTable.user_id == user_id)
    )
    row = result.mappings().one_or_none()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Attachment not found.")
    return row


async def _cached_preview(db: AsyncSession, user_id: str, source_sha256: str) -> bytes | None:
    """A PDF already rendered from these exact bytes for one of the user's own
    attachments (a re-upload or a forked copy hits it too); never another user's."""
    result = await db.execute(
        select(AttachmentPdfPreviewTable.data)
        .join(AttachmentTable, AttachmentTable.id == AttachmentPdfPreviewTable.attachment_id)
        .join(MessageTable, MessageTable.id == AttachmentTable.message_id)
        .join(ConversationTable, ConversationTable.id == MessageTable.conversation_id)
        .where(AttachmentPdfPreviewTable.source_sha256 == source_sha256, ConversationTable.user_id == user_id)
        .limit(1)
    )
    data = result.scalar_one_or_none()
    return bytes(data) if data is not None else None


async def _store_preview(db: AsyncSession, attachment_id: str, source_sha256: str, pdf: bytes) -> None:
    """Cache the rendering beside its attachment. A concurrent request that
    stored it first wins; this one's copy is dropped."""
    db.add(AttachmentPdfPreviewTable(attachment_id=attachment_id, source_sha256=source_sha256,
                                     data=pdf, size_bytes=len(pdf)))
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()


def _pdf_response(pdf: bytes, file_name: str | None) -> Response:
    stem = (file_name or "").rsplit(".", 1)[0]
    name = _safe_download_name(quote(f"{stem}.pdf"), "pdf")
    return Response(
        content=pdf,
        media_type="application/pdf",
        headers={
            "Content-Disposition": content_disposition(name, "inline", "pdf"),
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": f"private, max-age={settings.attachments.inline_cache_max_age_seconds}",
            # Fetched by the UI and drawn by its own viewer; opened directly
            # it runs nothing on the app origin (as the inline /preview route).
            "Content-Security-Policy": "sandbox; default-src 'none'",
        },
    )


async def office_pdf_preview(db: AsyncSession, user_id: str, attachment_id: str) -> Response:
    """An owned Office attachment as a PDF: from the cache, else rendered in
    the box and cached. 404 not the user's, 415 not an Office file, 413 too
    large, and the structured 502/503/504 of the module docstring."""
    operation = "office_preview"
    row = await _owned_attachment(db, user_id, attachment_id)
    ext = office_extension(row["file_name"], row["mime_type"])
    if ext is None:
        raise HTTPException(status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, "Only Office documents are previewed as a PDF.")
    if row["size"] is not None and row["size"] > settings.attachments.pdf_preview_max_source_bytes:
        raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, "The file is too large to preview.")

    source_sha256 = row["content_sha256"]
    if source_sha256:
        cached = await _cached_preview(db, user_id, source_sha256)
        if cached is not None:
            logger.info("office_preview_cache_hit", "Served a cached Office PDF preview", extension=ext)
            return _pdf_response(cached, row["file_name"])

    data = (await db.execute(select(BlobTable.data).where(BlobTable.id == row["blob_id"]))).scalar_one_or_none()
    if not data:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Attachment not found.")
    data = bytes(data)
    if len(data) > settings.attachments.pdf_preview_max_source_bytes:
        raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, "The file is too large to preview.")
    if not source_sha256:
        # Older uploads have no recorded hash: hash the bytes themselves.
        source_sha256 = hashlib.sha256(data).hexdigest()
        cached = await _cached_preview(db, user_id, source_sha256)
        if cached is not None:
            logger.info("office_preview_cache_hit", "Served a cached Office PDF preview", extension=ext)
            return _pdf_response(cached, row["file_name"])

    response = await _post(
        build_conversation_office_preview_url(user_id, row["conversation_id"]),
        operation=operation,
        params={"extension": ext},
        content=data,
    )
    if response.status_code == status.HTTP_413_CONTENT_TOO_LARGE:
        raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, "The file is too large to preview.")
    failure = _conversion_failure(response)
    if failure is not None:
        logger.warning("office_preview_unavailable", "An Office PDF preview could not run in the sandbox",
                       extension=ext, status_code=response.status_code)
        return failure
    _raise_unexpected(response, operation)

    pdf = response.content
    if response.headers.get("content-type", "").split(";")[0].strip().lower() != "application/pdf":
        return _bad_payload(operation, "content_type")
    if not pdf.startswith(b"%PDF-") or len(pdf) > settings.attachments.pdf_preview_max_bytes:
        return _bad_payload(operation, "not_a_pdf_or_too_large")
    await _store_preview(db, attachment_id, source_sha256, pdf)
    logger.info("office_preview_rendered", "Rendered and cached an Office PDF preview", extension=ext,
                size_bytes=len(pdf))
    return _pdf_response(pdf, row["file_name"])


__all__ = [
    "EXPORT_MEDIA_TYPES",
    "OFFICE_PDF_PREVIEW_MIME_BY_EXT",
    "content_disposition",
    "export_document",
    "office_extension",
    "office_pdf_preview",
    "sandbox_error",
]
