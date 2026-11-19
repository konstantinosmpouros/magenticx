"""The user's pending suggestions on a canvas document (plan 44, Phase 4.6): the browser's contract.

In the canvas's Suggesting mode the user's edits become suggestions; the set
pending on one document is stored by the agents service
(``agent_runtime.conversation_file_suggestions``) as the proposed full text on
the version it was made on. The agents service speaks snake_case and the
browser camelCase, so the request body is camelCase here and mapped to
snake_case upstream, and every upstream set is re-validated into
:class:`DocumentSuggestionOut` (camelCase names, the snake_case keys accepted
as validation aliases) before it reaches the browser. A malformed upstream
body is a 502, never forwarded.
"""
from pydantic import BaseModel, ConfigDict, Field

from schema.base import UTCDateTime
from schema.documents.documents import DOCUMENT_CONTENT_MAX_CHARS, DOCUMENT_PATH_MAX_CHARS


class DocumentSuggestionIn(BaseModel):
    """The pending set the canvas saves: the proposed text and the accepted version it was made on."""

    model_config = ConfigDict(extra="forbid")

    path: str = Field(min_length=1, max_length=DOCUMENT_PATH_MAX_CHARS)
    baseVersion: int = Field(ge=1)
    content: str = Field(max_length=DOCUMENT_CONTENT_MAX_CHARS)

    def upstream(self) -> dict:
        """The agents service's snake_case body."""
        return {"path": self.path, "base_version": self.baseVersion, "content": self.content}


class DocumentSuggestionOut(BaseModel):
    """A document's pending set as the browser gets it (camelCase); upstream snake_case keys are accepted."""

    model_config = ConfigDict(extra="ignore", populate_by_name=True)

    path: str = Field(max_length=DOCUMENT_PATH_MAX_CHARS)
    baseVersion: int = Field(ge=1, validation_alias="base_version")
    content: str = Field(max_length=DOCUMENT_CONTENT_MAX_CHARS)
    updatedAt: UTCDateTime = Field(validation_alias="updated_at")
