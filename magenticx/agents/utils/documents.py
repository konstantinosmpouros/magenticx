"""What the bridge asks of a conversation's canvas documents (plan 44, Phase 4.1).

Thin over :class:`~harness.conversation_files.DocumentVersionStore`: validates
every path into its canonical form (:func:`document_path` — ``422`` when it is
not a ``.md`` under ``/conversation/output/``) and shapes the store's rows into
the response schemas. The routes in ``router/documents.py`` only translate the
store's exceptions into statuses. Logs carry counts and versions, never a path
or a byte of content — both can hold the user's words.
"""
from __future__ import annotations

from harness.conversation_files import DocumentVersionStore
from harness.conversation_files.versions import (
    DocumentVersion,
    InvalidDocumentPath,
    document_path,
)
from harness.memory import get_memory_pool
from schema import (
    CapturedDocument,
    CaptureDocumentsResponse,
    DocumentListResponse,
    DocumentSummary,
    DocumentVersionContent,
    DocumentVersionsResponse,
    DocumentVersionSummary,
    SaveDocumentVersionResponse,
)


def _store() -> DocumentVersionStore:
    return DocumentVersionStore(get_memory_pool())


def _content(version: DocumentVersion) -> DocumentVersionContent:
    return DocumentVersionContent(
        path=version.path,
        name=version.name,
        version=version.version,
        author=version.author,
        base_version=version.base_version,
        created_at=version.created_at,
        size_bytes=version.size_bytes,
        content=version.content or "",
    )


async def list_documents(user_id: str, conversation_id: str, limit: int) -> DocumentListResponse:
    """The conversation's documents, each at its latest version, newest first."""
    rows = await _store().list_documents(user_id, conversation_id, limit=limit)
    return DocumentListResponse(documents=[
        DocumentSummary(path=row.path, name=row.name, version=row.version, author=row.author,
                        updated_at=row.created_at, size_bytes=row.size_bytes)
        for row in rows
    ])


async def latest_document(user_id: str, conversation_id: str, path: str) -> DocumentVersionContent:
    """The latest version with its text (v1 recorded first for an older document)."""
    canonical = document_path(path)  # before the store: a bad path never reaches SQL
    return _content(await _store().latest(user_id, conversation_id, canonical))


async def list_document_versions(
    user_id: str, conversation_id: str, path: str, limit: int
) -> DocumentVersionsResponse:
    """A document's history without text, newest first. An empty list is not an error:
    the UI asks after it opened the document, which already recorded v1."""
    canonical = document_path(path)
    rows = await _store().list_versions(user_id, conversation_id, canonical, limit=limit)
    return DocumentVersionsResponse(path=canonical, versions=[
        DocumentVersionSummary(version=row.version, author=row.author, base_version=row.base_version,
                               created_at=row.created_at, size_bytes=row.size_bytes)
        for row in rows
    ])


async def get_document_version(
    user_id: str, conversation_id: str, path: str, version: int
) -> DocumentVersionContent:
    """One version with its text; the store raises ``DocumentNotFound`` when absent."""
    canonical = document_path(path)
    return _content(await _store().get_version(user_id, conversation_id, canonical, version))


async def save_document_version(
    user_id: str, conversation_id: str, path: str, base_version: int, content: str
) -> SaveDocumentVersionResponse:
    """The user's save as the next version; ``StaleBase`` when ``base_version`` is not the latest."""
    canonical = document_path(path)
    saved = await _store().save_user_version(
        user_id, conversation_id, canonical, base_version=base_version, content=content
    )
    return SaveDocumentVersionResponse(path=saved.path, version=saved.version, created_at=saved.created_at)


async def capture_documents(
    user_id: str, conversation_id: str, paths: list[str], source_run_id: str | None
) -> CaptureDocumentsResponse:
    """Record the presented documents as agent versions where they changed.

    Ineligible paths (not a ``.md`` under output/, or malformed) are skipped
    silently, like missing files: the bridge sends what the run presented and
    must not fail on a path the agent got wrong.
    """
    eligible: list[str] = []
    for path in paths:
        try:
            canonical = document_path(path)
        except InvalidDocumentPath:
            continue
        if canonical not in eligible:
            eligible.append(canonical)
    results = await _store().capture(user_id, conversation_id, eligible, run_id=source_run_id)
    return CaptureDocumentsResponse(captured=[
        CapturedDocument(path=r.path, version=r.version, created=r.created) for r in results
    ])
