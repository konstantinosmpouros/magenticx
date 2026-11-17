"""What the bridge asks of a conversation's sources: read, insert, fork copy, delete.

Thin over :class:`~harness.sources.ConversationSourceStore`; the routes in
``router/conversation_sources.py`` only translate. The rows are written by
``SourcesMiddleware`` during runs; the one write through these calls is
:func:`insert_conversation_sources`, which gives a conversation continued
from a share link the sources its copied answers cite.
"""
from __future__ import annotations

from core.logging import get_logger
from harness.memory import get_memory_pool
from harness.sources import ConversationSourceStore, Source, id_matches_url

logger = get_logger(__name__)


def _store() -> ConversationSourceStore:
    return ConversationSourceStore(get_memory_pool())


async def list_conversation_sources(user_id: str, conversation_id: str) -> list[Source]:
    """The conversation's sources, newest first, at most 500."""
    return await _store().list_sources(user_id, conversation_id)


async def insert_conversation_sources(user_id: str, conversation_id: str, sources: list[Source]) -> int:
    """Keep ``sources`` for the conversation (upsert); how many were kept.

    A source whose id is not its URL's (:func:`~harness.sources.id_matches_url`)
    is dropped on its own and counted in the log — never its URL or title.
    """
    kept = [source for source in sources if id_matches_url(source.id, source.url)]
    if len(kept) < len(sources):
        logger.warning("conversation_sources_insert_dropped", "Dropped inserted sources whose id is not their URL's",
                       received=len(sources), kept=len(kept))
    inserted = await _store().upsert_many(user_id, conversation_id, kept)
    logger.info("conversation_sources_inserted", "Inserted a conversation's sources", sources=inserted)
    return inserted


async def copy_conversation_sources(user_id: str, source_id: str, target_id: str) -> int:
    """A fork's sources: every row of the conversation it was forked from."""
    return await _store().copy_conversation(user_id, source_id, target_id)


async def delete_conversation_sources(user_id: str, conversation_id: str) -> int:
    """Delete the conversation's sources (idempotent: none left is success)."""
    return await _store().delete_conversation(user_id, conversation_id)
