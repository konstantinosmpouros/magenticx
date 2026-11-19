"""Internal routes: export a canvas document, render an Office file as a PDF (plan 44, Phase 4.5).

The bridge's calls, internal-caller only, keyed by user and conversation like
the document routes. Both answer the file itself. The handlers only map
exceptions to statuses:

* ``InvalidDocumentPath`` / a bad format / an empty body → 422; over the
  sandbox's input cap → 413
* ``DocumentNotFound`` → 404
* ``ConversionUnavailable`` → 503 (the box cannot run: execution off, no
  runner, runner down or busy), ``ConversionTimeout`` → 504,
  ``ConversionFailed`` → 502 — each with a plain-string ``detail`` naming the
  case (``sandbox_unavailable`` / ``conversion_timeout`` /
  ``conversion_failed``); the bridge builds the browser's body from the status.
"""
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status

from core.security.internal_trust import require_internal_caller
from harness.conversation_files.versions import DocumentNotFound, InvalidDocumentPath
from harness.conversions import (
    MAX_INPUT_BYTES,
    ConversionFailed,
    ConversionTimeout,
    ConversionUnavailable,
    OfficeExtension,
)
from schema import ExportDocumentRequest
from utils.document_export import export_document, render_office_preview

router = APIRouter(
    prefix="/users/{user_id}/conversations/{conversation_id}",
    dependencies=[Depends(require_internal_caller)],
)

#: The download's name, percent-encoded UTF-8 (a header is latin-1 only).
FILENAME_HEADER = "X-Export-Filename"
VERSION_HEADER = "X-Document-Version"


def _conversion_error(exc: Exception) -> HTTPException:
    if isinstance(exc, ConversionTimeout):
        return HTTPException(status.HTTP_504_GATEWAY_TIMEOUT, "conversion_timeout")
    if isinstance(exc, ConversionUnavailable):
        return HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "sandbox_unavailable")
    return HTTPException(status.HTTP_502_BAD_GATEWAY, "conversion_failed")


@router.post("/documents/export")
async def export_canvas_document(user_id: str, conversation_id: str, payload: ExportDocumentRequest) -> Response:
    """One version of a document as docx / pdf (through the box) or md (as stored)."""
    try:
        exported = await export_document(user_id, conversation_id, payload.path, payload.version, payload.format)
    except InvalidDocumentPath as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT,
                            "A canvas document is a .md file under /conversation/output/.") from exc
    except DocumentNotFound as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such document.") from exc
    except (ConversionUnavailable, ConversionTimeout, ConversionFailed) as exc:
        raise _conversion_error(exc) from exc
    return Response(
        content=exported.content,
        media_type=exported.media_type,
        headers={FILENAME_HEADER: quote(exported.filename, safe=""), VERSION_HEADER: str(exported.version)},
    )


@router.post("/office-preview")
async def render_office_file_as_pdf(
    user_id: str, conversation_id: str, request: Request, extension: OfficeExtension = Query(...)
) -> Response:
    """The request body (an Office file the bridge owner-checked) as a PDF."""
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > MAX_INPUT_BYTES:
        raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, "The file is too large to preview.")
    data = await request.body()
    if len(data) > MAX_INPUT_BYTES:
        raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, "The file is too large to preview.")
    if not data:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "The file is empty.")
    try:
        pdf = await render_office_preview(user_id, conversation_id, extension, data)
    except (ConversionUnavailable, ConversionTimeout, ConversionFailed) as exc:
        raise _conversion_error(exc) from exc
    return Response(content=pdf, media_type="application/pdf")
