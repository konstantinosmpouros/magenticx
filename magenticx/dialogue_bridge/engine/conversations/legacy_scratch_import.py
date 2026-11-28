"""One-shot (plan 41 §3.7): have the agents service import every branch's legacy scratch files.

Before the scratch store, a deep agent's working files lived in its branch
thread's checkpoint state. The agents service imports them the first time a
branch is used, so a conversation nobody reopens kept them only there — and a
later release that drops that import would lose them. At boot this job sends
every branch the bridge knows (``messages.checkpoint_thread_id`` with its
conversation and user) to ``POST /internal/scratch/legacy-import``, in batches.
The agents service marks each branch imported, so a rerun (every boot until
this is deleted) only costs one indexed read and a few no-op calls.

**Delete this module** (and its call in ``main.py``) in the release after it
has run on Dennis, together with the agents service's
``router/scratch_import.py``, ``schema/scratch_import.py`` and
``harness/filesystem/scratch_migration.py``.

It runs in the background and never fails the boot: the agents service may
still be starting (it answers 503 until its checkpointer is ready), so a failed
batch is retried with a growing pause until it goes through or the bridge
stops. No database connection is held while waiting on the agents service.
"""
from __future__ import annotations

import asyncio

import httpx
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError

from core.database import ConversationTable, MessageTable, SessionLocal
from core.logging import get_logger
from core.security.internal_trust import internal_service_headers
from core.security.tls import get_httpx_client_cert, get_httpx_verify
from core.settings import settings

logger = get_logger(__name__)

#: Branches per call — the agents service accepts at most 200.
BATCH = 200
#: The first pause after a failed batch, then doubled up to the cap.
FIRST_RETRY_SECONDS = 10.0
MAX_RETRY_SECONDS = 300.0

Branch = dict[str, str]


async def _branches() -> list[Branch]:
    """Every (thread, user, conversation) a message records, once each."""
    async with SessionLocal() as db:
        rows = (await db.execute(
            select(MessageTable.checkpoint_thread_id, ConversationTable.user_id, MessageTable.conversation_id)
            .join(ConversationTable, ConversationTable.id == MessageTable.conversation_id)
            .where(MessageTable.checkpoint_thread_id.is_not(None))
            .distinct()
        )).all()
    return [
        {"thread_id": str(thread_id), "user_id": str(user_id), "conversation_id": str(conversation_id)}
        for thread_id, user_id, conversation_id in rows
        if thread_id and user_id and conversation_id
    ]


async def _send(client: httpx.AsyncClient, batch: list[Branch]) -> int:
    """One batch to the agents service; returns how many files it imported."""
    base = settings.upstream.agents_service_url.rstrip("/")
    resp = await client.post(f"{base}/internal/scratch/legacy-import", json={"branches": batch},
                             headers=internal_service_headers(None))
    resp.raise_for_status()
    body = resp.json()
    files = body.get("files", 0) if isinstance(body, dict) else 0
    return files if isinstance(files, int) else 0


async def run_legacy_scratch_import(stop_event: asyncio.Event) -> int:
    """Send every branch, retrying a failed batch until it goes through; returns the files imported.

    Returns early (with what it has) when ``stop_event`` is set. Never raises.
    """
    try:
        branches = await _branches()
    except SQLAlchemyError as exc:
        logger.warning("legacy_scratch_import_read_failed", "Could not list the branches to import",
                       error_type=type(exc).__name__)
        return 0
    imported = 0
    async with httpx.AsyncClient(
        timeout=settings.http.agents_timeout, verify=get_httpx_verify(), cert=get_httpx_client_cert()
    ) as client:
        for start in range(0, len(branches), BATCH):
            batch = branches[start:start + BATCH]
            pause = FIRST_RETRY_SECONDS
            while True:
                try:
                    imported += await _send(client, batch)
                    break
                except (httpx.HTTPError, ValueError) as exc:
                    logger.info("legacy_scratch_import_retry", "The agents service did not take a batch yet",
                                error_type=type(exc).__name__, retry_in_seconds=pause)
                    try:
                        await asyncio.wait_for(stop_event.wait(), timeout=pause)
                        return imported  # the bridge is stopping
                    except asyncio.TimeoutError:
                        pause = min(pause * 2, MAX_RETRY_SECONDS)
    logger.info("legacy_scratch_import_done", "Every branch's legacy scratch files are imported",
                branches=len(branches), files=imported)
    return imported


__all__ = ["run_legacy_scratch_import"]
