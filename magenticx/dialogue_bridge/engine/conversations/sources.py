"""A conversation's files and citation sources in the agents service:
copied on fork, inserted on share import, fetched for export.
"""

import httpx
from core.logging import get_context, get_logger
from core.settings import settings
from core.security.tls import get_httpx_client_cert, get_httpx_verify
from core.security.internal_trust import internal_service_headers
from schema import ConversationSource, keep_valid_sources
from engine.agents.service_urls import build_conversation_files_url, build_conversation_sources_url

logger = get_logger(__name__)

async def _copy_to_fork(url: str, target_id: str) -> None:
    """POST ``{"target_conversation_id": target_id}`` to an agents-service copy
    route; raises ``httpx.HTTPError`` for the caller to log."""
    async with httpx.AsyncClient(
        timeout=settings.http.agents_timeout, verify=get_httpx_verify(), cert=get_httpx_client_cert()
    ) as client:
        resp = await client.post(
            url,
            json={"target_conversation_id": target_id},
            headers=internal_service_headers(get_context().get("request_id")),
        )
        resp.raise_for_status()


async def copy_conversation_files(user_id: str, source_id: str, target_id: str) -> None:
    """Give a fork its source conversation's files (paths only — the agents
    service shares the bytes). Best-effort: a fork without them is still a
    fork, so a failure is logged, not raised."""
    try:
        await _copy_to_fork(f"{build_conversation_files_url(user_id, source_id)}/copy", target_id)
    except httpx.HTTPError as exc:
        logger.warning("conversation_files_copy_failed", "Could not give a fork its source's files",
                       conversation_id=target_id, error_type=type(exc).__name__)


async def copy_conversation_sources(user_id: str, source_id: str, target_id: str) -> None:
    """Give a fork its source conversation's citation sources (plan 42), so the
    markers in the copied answers keep resolving. Best-effort like the files:
    without them the fork's citations just don't render."""
    try:
        await _copy_to_fork(f"{build_conversation_sources_url(user_id, source_id)}/copy", target_id)
    except httpx.HTTPError as exc:
        logger.warning("conversation_sources_copy_failed", "Could not give a fork its source's citation sources",
                       conversation_id=target_id, error_type=type(exc).__name__)


async def insert_conversation_sources(user_id: str, conversation_id: str, sources: list[ConversationSource]) -> None:
    """Give a conversation continued from a share link the snapshot's sources (plan 42).

    Its copied answers cite the sharer's sources, which the share snapshot
    froze; stored under the new conversation, those markers resolve there too.
    Best-effort like a fork's copy: without them the continued conversation's
    old citations just don't render. Logs carry counts and error types only.
    """
    if not sources:
        return
    try:
        async with httpx.AsyncClient(
            timeout=settings.http.agents_timeout, verify=get_httpx_verify(), cert=get_httpx_client_cert()
        ) as client:
            resp = await client.post(
                build_conversation_sources_url(user_id, conversation_id),
                json={"sources": [source.model_dump() for source in sources]},
                headers=internal_service_headers(get_context().get("request_id")),
            )
            resp.raise_for_status()
    except httpx.HTTPError as exc:
        logger.warning("conversation_sources_insert_failed",
                       "Could not give a continued conversation its share's citation sources",
                       conversation_id=conversation_id, sources=len(sources), error_type=type(exc).__name__)


async def fetch_conversation_sources(user_id: str, conversation_id: str) -> list[ConversationSource]:
    """The conversation's citation sources (plan 42), validated, newest first.

    The caller has already checked that ``user_id`` owns the conversation. Fail
    open to an empty list: the agents service being down, slow or answering
    something unexpected only means the citations don't render, never that the
    conversation fails to load. Each source is re-validated here (``http(s)``
    URLs, capped lengths) and a bad one is dropped on its own. Logs carry
    counts and error types only — URLs and snippets can hold search terms.
    """
    url = build_conversation_sources_url(user_id, conversation_id)
    try:
        async with httpx.AsyncClient(
            timeout=settings.http.agents_timeout, verify=get_httpx_verify(), cert=get_httpx_client_cert()
        ) as client:
            resp = await client.get(url, headers=internal_service_headers(get_context().get("request_id")))
            resp.raise_for_status()
        body = resp.json()
    except (httpx.HTTPError, ValueError) as exc:
        logger.warning("conversation_sources_unavailable", "Could not load the conversation's citation sources",
                       conversation_id=conversation_id, error_type=type(exc).__name__)
        return []
    items = body.get("sources") if isinstance(body, dict) else None
    if not isinstance(items, list):
        logger.warning("conversation_sources_invalid_payload",
                       "Agents service returned an unexpected citation-sources payload",
                       conversation_id=conversation_id)
        return []
    sources = keep_valid_sources(items)
    if len(sources) < len(items):
        logger.warning("conversation_sources_dropped", "Dropped citation sources that failed validation",
                       conversation_id=conversation_id, received=len(items), kept=len(sources))
    return sources
