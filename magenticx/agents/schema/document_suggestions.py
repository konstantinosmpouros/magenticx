"""Bridge ↔ agents: the user's pending suggestions on a canvas document (plan 44, Phase 4.6).

One set per document: the proposed full markdown on the accepted version it
was made on. The path travels as a query or body field, never inside the URL
path, like the other document routes.
"""
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

#: Same bound as the file store's paths (``paths.MAX_PATH_BYTES``).
_PATH_MAX = 1024


class PutDocumentSuggestionRequest(BaseModel):
    """The user's pending set: the proposed text and the version it was made on.

    ``content`` is bounded here in characters as a cheap first cut; the real
    cap (1 MiB of UTF-8, like a version) is checked on the encoded bytes.
    """

    model_config = ConfigDict(extra="forbid")

    path: str = Field(min_length=1, max_length=_PATH_MAX)
    base_version: int = Field(ge=1)
    content: str = Field(max_length=1024 * 1024)


class DocumentSuggestionOut(BaseModel):
    """A document's pending set as stored."""

    path: str
    base_version: int
    content: str
    updated_at: datetime
