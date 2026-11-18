"""Bridge ↔ agents: a conversation's canvas documents and their versions (plan 44, Phase 4.1).

The path of a document always travels as a query or body field, never inside
the URL path, so a ``/`` in it can never be read as a route segment.
"""
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

#: Same bound as the file store's paths (``paths.MAX_PATH_BYTES``).
_PATH_MAX = 1024
#: How many presented paths one capture may name (a run presents a handful).
_CAPTURE_MAX_PATHS = 50

Author = Literal["agent", "user"]


class DocumentSummary(BaseModel):
    """A document as the switcher lists it: its latest version, no text."""

    path: str
    name: str
    version: int
    author: Author
    updated_at: datetime
    size_bytes: int


class DocumentListResponse(BaseModel):
    documents: list[DocumentSummary]


class DocumentVersionContent(BaseModel):
    """One version with its text — the latest, or the one asked for."""

    path: str
    name: str
    version: int
    author: Author
    base_version: int | None = None
    created_at: datetime
    size_bytes: int
    content: str


class DocumentVersionSummary(BaseModel):
    """One version in the history list, without its text."""

    version: int
    author: Author
    base_version: int | None = None
    created_at: datetime
    size_bytes: int


class DocumentVersionsResponse(BaseModel):
    path: str
    versions: list[DocumentVersionSummary]


class SaveDocumentVersionRequest(BaseModel):
    """The user's save: the text, and the version it was edited from.

    ``content`` is bounded here in characters as a cheap first cut; the real
    cap (1 MiB of UTF-8) is checked on the encoded bytes.
    """

    path: str = Field(min_length=1, max_length=_PATH_MAX)
    base_version: int = Field(ge=1)
    content: str = Field(max_length=1024 * 1024)


class SaveDocumentVersionResponse(BaseModel):
    path: str
    version: int
    created_at: datetime


class CaptureDocumentsRequest(BaseModel):
    """Run end: record the presented documents' current files as agent versions."""

    paths: list[str] = Field(default_factory=list, max_length=_CAPTURE_MAX_PATHS)
    source_run_id: str | None = Field(None, max_length=128)


class CapturedDocument(BaseModel):
    path: str
    version: int
    created: bool


class CaptureDocumentsResponse(BaseModel):
    captured: list[CapturedDocument]
