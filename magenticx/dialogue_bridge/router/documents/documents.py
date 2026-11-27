"""A conversation's canvas documents (plan 44, Phase 4.1): the browser's routes.

Mounted under ``/v1/conversations`` like every conversation-scoped route, so
the path is ``/{user_id}/{conversation_id}/documents…``: ``validate_userId``
binds the session to the path's user, ``validate_convId`` is the owner check
(someone else's conversation, or a "Try it" trial, is a 404 with no upstream
call, so existence never leaks), then the per-user rate limit — after auth on
purpose, since the bucket is keyed on the path's user. The save and the export
(Phase 4.5, a POST) also need the CSRF token. A document's path is a query or body field, never a URL segment.
"""
from fastapi import APIRouter, Depends, Path, Query, Response, status

from core.auth.session import AuthUser, require_csrf_protection
from core.database import ConversationTable
from core.logging import set_context
from core.security.rate_limit import (
    document_export_rate_limit,
    document_read_rate_limit,
    document_save_rate_limit,
)
from schema import (
    DocumentExportIn,
    DocumentListOut,
    DocumentSaveIn,
    DocumentSaveOut,
    DocumentVersionOut,
    DocumentVersionsOut,
)
from schema.documents.documents import DOCUMENT_PATH_MAX_CHARS
from utils.validators import validate_convId, validate_userId
from engine.conversations.file_branches import FileBranch, document_branch
from engine.documents.export import export_document
from engine.documents.documents import (
    get_document_version,
    latest_document,
    list_document_versions,
    list_documents,
    save_document_version,
)

router = APIRouter()

_PATH_QUERY = Query(min_length=1, max_length=DOCUMENT_PATH_MAX_CHARS, description="The document's virtual path.")
_LIMIT_QUERY = Query(100, ge=1, le=200)


@router.get("/{user_id}/{conversation_id}/documents", response_model=DocumentListOut,
            summary="List a conversation's canvas documents")
async def listConversationDocuments(
    user_id: str,
    conversation_id: str,
    limit: int = _LIMIT_QUERY,
    current_user: AuthUser = Depends(validate_userId),
    _rate_limited: None = Depends(document_read_rate_limit),
    current_conv: ConversationTable = Depends(validate_convId),
    branch: FileBranch = Depends(document_branch),
) -> DocumentListOut:
    """Each document at its latest version, newest first (the canvas's ▾ switcher)."""
    set_context(user_id=user_id, conversation_id=conversation_id)
    return await list_documents(current_user.id, current_conv.id, limit, branch=branch)


@router.get("/{user_id}/{conversation_id}/documents/latest", response_model=DocumentVersionOut,
            summary="Open a canvas document at its latest version")
async def getLatestDocument(
    user_id: str,
    conversation_id: str,
    path: str = _PATH_QUERY,
    current_user: AuthUser = Depends(validate_userId),
    _rate_limited: None = Depends(document_read_rate_limit),
    current_conv: ConversationTable = Depends(validate_convId),
    branch: FileBranch = Depends(document_branch),
) -> DocumentVersionOut:
    """The latest version with its text."""
    set_context(user_id=user_id, conversation_id=conversation_id)
    return await latest_document(current_user.id, current_conv.id, path, branch=branch)


@router.get("/{user_id}/{conversation_id}/documents/versions", response_model=DocumentVersionsOut,
            summary="List a canvas document's versions")
async def listDocumentVersions(
    user_id: str,
    conversation_id: str,
    path: str = _PATH_QUERY,
    limit: int = _LIMIT_QUERY,
    current_user: AuthUser = Depends(validate_userId),
    _rate_limited: None = Depends(document_read_rate_limit),
    current_conv: ConversationTable = Depends(validate_convId),
    branch: FileBranch = Depends(document_branch),
) -> DocumentVersionsOut:
    """The document's versions with their authors, newest first, without text."""
    set_context(user_id=user_id, conversation_id=conversation_id)
    return await list_document_versions(current_user.id, current_conv.id, path, limit, branch=branch)


@router.get("/{user_id}/{conversation_id}/documents/versions/{version}", response_model=DocumentVersionOut,
            summary="Open one version of a canvas document")
async def getDocumentVersion(
    user_id: str,
    conversation_id: str,
    version: int = Path(ge=1),
    path: str = _PATH_QUERY,
    current_user: AuthUser = Depends(validate_userId),
    _rate_limited: None = Depends(document_read_rate_limit),
    current_conv: ConversationTable = Depends(validate_convId),
    branch: FileBranch = Depends(document_branch),
) -> DocumentVersionOut:
    """One version with its text; 404 when the document has no such version."""
    set_context(user_id=user_id, conversation_id=conversation_id)
    return await get_document_version(current_user.id, current_conv.id, path, version, branch=branch)


@router.post("/{user_id}/{conversation_id}/documents/versions", response_model=DocumentSaveOut,
             status_code=status.HTTP_201_CREATED, summary="Save a new version of a canvas document")
async def saveDocumentVersion(
    user_id: str,
    conversation_id: str,
    payload: DocumentSaveIn,
    current_user: AuthUser = Depends(validate_userId),
    _csrf: None = Depends(require_csrf_protection),
    _rate_limited: None = Depends(document_save_rate_limit),
    current_conv: ConversationTable = Depends(validate_convId),
    branch: FileBranch = Depends(document_branch),
) -> DocumentSaveOut:
    """The user's text as the next version. 409 with the latest version and its
    text when ``base_version`` is no longer the latest — never last-write-wins."""
    set_context(user_id=user_id, conversation_id=conversation_id)
    return await save_document_version(current_user.id, current_conv.id, payload, branch=branch)


@router.post("/{user_id}/{conversation_id}/documents/export", summary="Export a canvas document as Word, PDF or Markdown",
             responses={200: {"content": {"application/pdf": {}, "text/markdown": {}}},
                        503: {"description": "sandbox_unavailable"}, 504: {"description": "conversion_timeout"}})
async def exportDocument(
    user_id: str,
    conversation_id: str,
    payload: DocumentExportIn,
    current_user: AuthUser = Depends(validate_userId),
    _csrf: None = Depends(require_csrf_protection),
    _rate_limited: None = Depends(document_export_rate_limit),
    current_conv: ConversationTable = Depends(validate_convId),
    branch: FileBranch = Depends(document_branch),
) -> Response:
    """One version (the latest by default) as a download (plan 44, Phase 4.5):
    ``md`` as stored; ``docx`` / ``pdf`` rendered in the sandbox box. 503
    ``sandbox_unavailable`` when the box cannot run, 504 on its timeout."""
    set_context(user_id=user_id, conversation_id=conversation_id)
    return await export_document(current_user.id, current_conv.id, payload, branch=branch)
