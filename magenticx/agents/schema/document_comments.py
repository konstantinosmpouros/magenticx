"""Bridge ↔ agents: comments on a canvas document (plan 44, Phase 4.4).

snake_case like the other document routes; the bridge maps to the browser's
camelCase. The bounds here repeat the store's (``harness.conversation_files.comments``)
so a bad request is refused before it reaches SQL; the store checks them again.
"""
from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

#: Same bound as the document routes' paths.
_PATH_MAX = 1024

CommentAuthor = Literal["agent", "user"]
CommentStatus = Literal["open", "resolved"]


class CommentAnchorModel(BaseModel):
    """Where a thread sits: the quoted passage and a little text either side."""

    model_config = ConfigDict(extra="forbid")

    quote: str = Field(min_length=1, max_length=2000)
    prefix: str = Field("", max_length=200)
    suffix: str = Field("", max_length=200)


class CreateCommentRequest(BaseModel):
    """A new thread (``anchor``, no ``parent_id``) or reply (``parent_id``, no ``anchor``)."""

    model_config = ConfigDict(extra="forbid")

    path: str = Field(min_length=1, max_length=_PATH_MAX)
    version: int = Field(ge=1)
    anchor: CommentAnchorModel | None = None
    body: str = Field(min_length=1, max_length=4000)
    parent_id: UUID | None = None


class UpdateCommentRequest(BaseModel):
    """Resolve / reopen a thread, and/or edit the user's own comment. At least one field."""

    model_config = ConfigDict(extra="forbid")

    status: CommentStatus | None = None
    body: str | None = Field(None, min_length=1, max_length=4000)


class DocumentCommentOut(BaseModel):
    """One comment, decrypted: a thread (``parent_id`` null) or a reply."""

    id: str
    path: str
    version: int
    parent_id: str | None = None
    anchor: CommentAnchorModel | None = None
    body: str
    author: CommentAuthor
    status: CommentStatus | None = None
    resolved_by: CommentAuthor | None = None
    resolution_note: str | None = None
    created_at: datetime
    updated_at: datetime


class DocumentCommentsResponse(BaseModel):
    """A document's comments, threads and replies together, oldest first."""

    comments: list[DocumentCommentOut]
