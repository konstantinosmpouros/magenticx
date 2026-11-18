"""A conversation's canvas documents and their versions (plan 44, Phase 4.1).

A canvas document is a ``.md`` file the agent presented from
``/conversation/output/``; the agents service keeps its versions
(``agent_runtime.conversation_file_versions``). The bridge passes them through
to the conversation's owner, in snake_case like the agents service, and
validates both ways: the request before it goes upstream, and every upstream
body before it reaches the browser (a malformed one is a 502, never forwarded).
"""
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from schema.base import UTCDateTime

#: The agents service's bound on a virtual path.
DOCUMENT_PATH_MAX_CHARS = 1024
#: The canvas cap (1 MiB of UTF-8). Characters here, bytes upstream.
DOCUMENT_CONTENT_MAX_CHARS = 1024 * 1024

DocumentAuthor = Literal["agent", "user"]


class _Upstream(BaseModel):
    """Upstream bodies: unknown fields are dropped, never forwarded."""

    model_config = ConfigDict(extra="ignore")


class DocumentSummaryOut(_Upstream):
    """A document at its latest version, without its text (the ▾ switcher)."""

    path: str = Field(max_length=DOCUMENT_PATH_MAX_CHARS)
    name: str = Field(max_length=DOCUMENT_PATH_MAX_CHARS)
    version: int = Field(ge=1)
    author: DocumentAuthor
    updated_at: UTCDateTime
    size_bytes: int = Field(ge=0)


class DocumentListOut(_Upstream):
    documents: list[DocumentSummaryOut]


class DocumentVersionOut(_Upstream):
    """One version with its text: the latest, or the one asked for."""

    path: str = Field(max_length=DOCUMENT_PATH_MAX_CHARS)
    name: str = Field(max_length=DOCUMENT_PATH_MAX_CHARS)
    version: int = Field(ge=1)
    author: DocumentAuthor
    base_version: int | None = None
    created_at: UTCDateTime
    size_bytes: int = Field(ge=0)
    content: str


class DocumentVersionSummaryOut(_Upstream):
    """One entry of a document's history, without its text."""

    version: int = Field(ge=1)
    author: DocumentAuthor
    base_version: int | None = None
    created_at: UTCDateTime
    size_bytes: int = Field(ge=0)


class DocumentVersionsOut(_Upstream):
    path: str = Field(max_length=DOCUMENT_PATH_MAX_CHARS)
    versions: list[DocumentVersionSummaryOut]


class DocumentSaveIn(BaseModel):
    """The user's save from the canvas: the text, and the version it was edited from."""

    model_config = ConfigDict(extra="forbid")

    path: str = Field(min_length=1, max_length=DOCUMENT_PATH_MAX_CHARS)
    base_version: int = Field(ge=1)
    content: str = Field(max_length=DOCUMENT_CONTENT_MAX_CHARS)


class DocumentSaveOut(_Upstream):
    path: str = Field(max_length=DOCUMENT_PATH_MAX_CHARS)
    version: int = Field(ge=1)
    created_at: UTCDateTime


class DocumentStaleBaseDetail(_Upstream):
    """The 409 a stale save gets: the latest version and its text, to show beside the user's."""

    code: Literal["stale_base"]
    message: str = "The document has a newer version."
    current_version: int = Field(ge=1)
    current_content: str
