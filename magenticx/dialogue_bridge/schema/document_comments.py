"""Comments on a canvas document (plan 44, Phase 4.4): the browser's contract.

The agents service keeps them (``agent_runtime.conversation_file_comments``)
in snake_case; the browser speaks camelCase, so the request bodies are
camelCase here and mapped to snake_case upstream, and every upstream comment
is re-validated into :class:`DocumentCommentOut` (camelCase field names, the
snake_case keys accepted as validation aliases) before it reaches the browser.
A malformed upstream body is a 502, never forwarded.
"""
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

from schema.base import UTCDateTime
from schema.documents import DOCUMENT_PATH_MAX_CHARS

#: The agents service's bounds (harness/conversation_files/comments.py).
COMMENT_BODY_MAX_CHARS = 4000
COMMENT_QUOTE_MAX_CHARS = 2000
COMMENT_CONTEXT_MAX_CHARS = 200
COMMENT_RESOLUTION_NOTE_MAX_CHARS = 1000

CommentAuthor = Literal["agent", "user"]
CommentStatus = Literal["open", "resolved"]
#: The codes of the agents service's 422s the browser is told about.
CommentRefusalCode = Literal["invalid_comment", "thread_limit", "reply_limit"]


class DocumentCommentAnchor(BaseModel):
    """Where a thread sits: the quoted passage and a little text either side of it."""

    model_config = ConfigDict(extra="forbid")

    quote: str = Field(min_length=1, max_length=COMMENT_QUOTE_MAX_CHARS)
    prefix: str = Field("", max_length=COMMENT_CONTEXT_MAX_CHARS)
    suffix: str = Field("", max_length=COMMENT_CONTEXT_MAX_CHARS)


class DocumentCommentIn(BaseModel):
    """A new thread (``anchor``, no ``parentId``) or reply (``parentId``, no ``anchor``)."""

    model_config = ConfigDict(extra="forbid")

    path: str = Field(min_length=1, max_length=DOCUMENT_PATH_MAX_CHARS)
    version: int = Field(ge=1)
    anchor: DocumentCommentAnchor | None = None
    body: str = Field(min_length=1, max_length=COMMENT_BODY_MAX_CHARS)
    parentId: UUID | None = None

    @model_validator(mode="after")
    def _thread_or_reply(self) -> "DocumentCommentIn":
        if (self.anchor is None) == (self.parentId is None):
            raise ValueError("A thread needs an anchor and no parentId; a reply needs a parentId and no anchor.")
        return self

    def upstream(self) -> dict:
        """The agents service's snake_case body."""
        return {
            "path": self.path,
            "version": self.version,
            "anchor": self.anchor.model_dump() if self.anchor is not None else None,
            "body": self.body,
            "parent_id": str(self.parentId) if self.parentId is not None else None,
        }


class DocumentCommentPatchIn(BaseModel):
    """Resolve / reopen a thread, and/or edit the user's own comment. At least one field."""

    model_config = ConfigDict(extra="forbid")

    status: CommentStatus | None = None
    body: str | None = Field(None, min_length=1, max_length=COMMENT_BODY_MAX_CHARS)

    @model_validator(mode="after")
    def _something(self) -> "DocumentCommentPatchIn":
        if self.status is None and self.body is None:
            raise ValueError("Send a status, a body, or both.")
        return self


class DocumentCommentOut(BaseModel):
    """One comment as the browser gets it (camelCase); upstream snake_case keys are accepted."""

    model_config = ConfigDict(extra="ignore", populate_by_name=True)

    id: UUID
    path: str = Field(max_length=DOCUMENT_PATH_MAX_CHARS)
    version: int = Field(ge=1)
    parentId: UUID | None = Field(None, validation_alias="parent_id")
    anchor: DocumentCommentAnchor | None = None
    body: str = Field(max_length=COMMENT_BODY_MAX_CHARS)
    author: CommentAuthor
    status: CommentStatus | None = None
    resolvedBy: CommentAuthor | None = Field(None, validation_alias="resolved_by")
    resolutionNote: str | None = Field(None, max_length=COMMENT_RESOLUTION_NOTE_MAX_CHARS,
                                       validation_alias="resolution_note")
    createdAt: UTCDateTime = Field(validation_alias="created_at")
    updatedAt: UTCDateTime = Field(validation_alias="updated_at")


class DocumentCommentsOut(BaseModel):
    """A document's threads and replies, resolved ones included, oldest first."""

    model_config = ConfigDict(extra="ignore")

    comments: list[DocumentCommentOut]


class DocumentCommentRefusal(BaseModel):
    """The agents service's 422 detail for a comment it refused, passed through as is."""

    model_config = ConfigDict(extra="ignore")

    code: CommentRefusalCode
    message: str = Field(max_length=300)
