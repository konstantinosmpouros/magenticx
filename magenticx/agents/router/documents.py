"""Internal routes over a conversation's canvas documents (plan 44, Phase 4.1).

The bridge's calls, internal-caller only, keyed by user and conversation like
the files. A document's path is a query or body field (never part of the URL
path). The handlers only map the store's exceptions to statuses:

* :class:`InvalidDocumentPath` / :class:`DocumentTooLarge` / :class:`DocumentPathTaken` → 422
* :class:`DocumentNotFound` → 404
* :class:`StaleBase` → 409 ``{"code": "stale_base", "message", "current_version", "current_content"}``
"""
from fastapi import APIRouter, Depends, HTTPException, Path, Query, status

from core.security.internal_trust import require_internal_caller
from harness.conversation_files.versions import (
    DocumentNotFound,
    DocumentPathTaken,
    DocumentTooLarge,
    InvalidDocumentPath,
    StaleBase,
)
from schema import (
    CaptureDocumentsRequest,
    CaptureDocumentsResponse,
    DocumentListResponse,
    DocumentVersionContent,
    DocumentVersionsResponse,
    SaveDocumentVersionRequest,
    SaveDocumentVersionResponse,
)
from utils.documents import (
    capture_documents,
    get_document_version,
    latest_document,
    list_document_versions,
    list_documents,
    save_document_version,
)

router = APIRouter(
    prefix="/users/{user_id}/conversations/{conversation_id}/documents",
    dependencies=[Depends(require_internal_caller)],
)

_PATH_QUERY = Query(min_length=1, max_length=1024, description="The document's virtual path.")
_LIMIT_QUERY = Query(100, ge=1, le=200)


def _not_found() -> HTTPException:
    return HTTPException(status.HTTP_404_NOT_FOUND, "No such document.")


def _invalid(exc: Exception) -> HTTPException:
    if isinstance(exc, DocumentTooLarge):
        return HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "The document is over 1 MiB.")
    if isinstance(exc, DocumentPathTaken):
        return HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "That path cannot hold a document.")
    return HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT,
                         "A canvas document is a .md file under /conversation/output/.")


@router.get("", response_model=DocumentListResponse)
async def list_conversation_documents(
    user_id: str, conversation_id: str, limit: int = _LIMIT_QUERY
) -> DocumentListResponse:
    """The conversation's documents at their latest version, newest first."""
    return await list_documents(user_id, conversation_id, limit)


@router.get("/latest", response_model=DocumentVersionContent)
async def read_latest_document(user_id: str, conversation_id: str, path: str = _PATH_QUERY) -> DocumentVersionContent:
    """The latest version with its text; a document without versions gets v1 first."""
    try:
        return await latest_document(user_id, conversation_id, path)
    except InvalidDocumentPath as exc:
        raise _invalid(exc) from exc
    except DocumentNotFound as exc:
        raise _not_found() from exc


@router.get("/versions", response_model=DocumentVersionsResponse)
async def list_versions_of_document(
    user_id: str, conversation_id: str, path: str = _PATH_QUERY, limit: int = _LIMIT_QUERY
) -> DocumentVersionsResponse:
    """A document's versions without their text, newest first."""
    try:
        return await list_document_versions(user_id, conversation_id, path, limit)
    except InvalidDocumentPath as exc:
        raise _invalid(exc) from exc


@router.get("/versions/{version}", response_model=DocumentVersionContent)
async def read_document_version(
    user_id: str, conversation_id: str, version: int = Path(ge=1), path: str = _PATH_QUERY
) -> DocumentVersionContent:
    """One version with its text; 404 when the document has no such version."""
    try:
        return await get_document_version(user_id, conversation_id, path, version)
    except InvalidDocumentPath as exc:
        raise _invalid(exc) from exc
    except DocumentNotFound as exc:
        raise _not_found() from exc


@router.post("/versions", response_model=SaveDocumentVersionResponse, status_code=status.HTTP_201_CREATED)
async def save_version_of_document(
    user_id: str, conversation_id: str, payload: SaveDocumentVersionRequest
) -> SaveDocumentVersionResponse:
    """The user's save as the next version; 409 with the latest text on a stale base."""
    try:
        return await save_document_version(
            user_id, conversation_id, payload.path, payload.base_version, payload.content
        )
    except (InvalidDocumentPath, DocumentTooLarge, DocumentPathTaken) as exc:
        raise _invalid(exc) from exc
    except DocumentNotFound as exc:
        raise _not_found() from exc
    except StaleBase as exc:
        # ``message`` is what lets a structured 4xx detail through the
        # service's exception handler (core/error_handling.py) intact.
        raise HTTPException(status.HTTP_409_CONFLICT, {
            "code": "stale_base",
            "message": "The document has a newer version.",
            "current_version": exc.current_version,
            "current_content": exc.current_content,
        }) from exc


@router.post("/capture", response_model=CaptureDocumentsResponse)
async def capture_presented_documents(
    user_id: str, conversation_id: str, payload: CaptureDocumentsRequest
) -> CaptureDocumentsResponse:
    """Run end: the presented documents' current files as agent versions, where changed."""
    return await capture_documents(user_id, conversation_id, payload.paths, payload.source_run_id)
