"""What the bridge asks of a canvas document's pending suggestions (plan 44, Phase 4.6).

Thin over :class:`~harness.conversation_files.DocumentSuggestionStore`: the
path is validated into its canonical form first (:func:`document_path` — a
422 before any SQL), and the store's set is shaped into the response schema.
The routes in ``router/document_suggestions.py`` map the store's exceptions to
statuses. Logs carry no path and no text — both can hold the user's words.
"""
from __future__ import annotations

from harness.conversation_files import DocumentSuggestionStore
from harness.conversation_files.suggestions import DocumentSuggestion
from harness.conversation_files.versions import document_path
from harness.memory import get_memory_pool
from schema import DocumentSuggestionOut


def _store() -> DocumentSuggestionStore:
    return DocumentSuggestionStore(get_memory_pool())


def _out(suggestion: DocumentSuggestion) -> DocumentSuggestionOut:
    return DocumentSuggestionOut(path=suggestion.path, base_version=suggestion.base_version,
                                 content=suggestion.content, updated_at=suggestion.updated_at)


async def get_document_suggestion(user_id: str, conversation_id: str, path: str) -> DocumentSuggestionOut | None:
    """The document's pending set, or None when it has none."""
    canonical = document_path(path)
    found = await _store().get(user_id, conversation_id, canonical)
    return _out(found) if found is not None else None


async def put_document_suggestion(
    user_id: str, conversation_id: str, path: str, base_version: int, content: str
) -> DocumentSuggestionOut | None:
    """Save the pending set; None when ``content`` equals the base (the set is cleared)."""
    canonical = document_path(path)
    saved = await _store().put(user_id, conversation_id, canonical, base_version=base_version, content=content)
    return _out(saved) if saved is not None else None


async def delete_document_suggestion(user_id: str, conversation_id: str, path: str) -> None:
    """Drop the pending set (idempotent)."""
    canonical = document_path(path)
    await _store().delete(user_id, conversation_id, canonical)
