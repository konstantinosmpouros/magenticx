"""Bridge ↔ agents: a conversation's sources (plan 42 §3.7).

The bridge reads them when it loads a conversation (the map an inline
``[src:ID]`` citation resolves against), gives a fork its source's, gives a
conversation continued from a share link the snapshot's frozen sources, and
deletes them with the conversation. Every item is validated by
:class:`harness.sources.Source` on the way out — search results are untrusted.
"""
from pydantic import BaseModel, Field

from harness.sources import MAX_LISTED_SOURCES, Source


class ConversationSourcesResponse(BaseModel):
    """Bridge ← agents: the conversation's sources, newest first."""
    sources: list[Source] = Field(default_factory=list, max_length=MAX_LISTED_SOURCES)


class InsertConversationSourcesRequest(BaseModel):
    """Bridge → agents: keep these sources for the conversation (upsert).

    Used when a conversation is continued from a share link: its copied
    answers cite the sharer's sources, which the share snapshot froze. Each
    item is a full :class:`Source` (``http(s)`` only, capped, unknown keys
    refused), at most :data:`MAX_LISTED_SOURCES` — a conversation never lists
    more, so a larger body is refused rather than half kept.
    """
    sources: list[Source] = Field(max_length=MAX_LISTED_SOURCES)


class CopyConversationSourcesRequest(BaseModel):
    """Bridge → agents: give a fork its source conversation's sources."""
    target_conversation_id: str = Field(min_length=1, max_length=128)
