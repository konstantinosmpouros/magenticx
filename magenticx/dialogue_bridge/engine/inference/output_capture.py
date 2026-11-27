"""Snapshot the files an agent presented this run, as attachments on its answer.

A deep agent's files are durable in the agents service (``agent_runtime``,
plan 36) for as long as the conversation exists, so only the files it
*presented* (``present_artifact``) are copied here — in the finalize
transaction, so each card finds its file when the run's terminal frame reaches
the UI. The copy is a deliberate snapshot: the card on an answer keeps the
version presented then, even if the agent later edits the file, and share
links, forks and the PDF export carry it like any other attachment.

Every stored row is ``AttachmentTable(origin="generated", presented=True)`` +
``BlobTable`` on the answer, with ``content_sha256`` taken from the bytes
received, and ``source_path`` set to the virtual path it was presented from.

A presented ``.md`` under ``/conversation/output/`` is also a canvas document
(plan 44): after the snapshot, :func:`capture_canvas_documents` asks the
agents service to record its current file as the agent's next version, so the
canvas history has every version the agent handed over. Since Phase 4.3 the
same call also records the conversation's *existing* documents the run changed
without presenting them again (an Ask agent edit is an ``edit_file``, not a new
presentation) and marks what the agent has now seen, so the next turn's note
only carries the user's own edits. It is made whenever the conversation has a
document at all, not only when this run presented one.

Fail-open throughout: the answer is already persisted, so an unreachable
agents service, a file gone or bad base64 is logged and skipped — never a
failed run.
"""
from __future__ import annotations

import base64
import hashlib
from typing import Any

import httpx
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from core.database import AttachmentTable, BlobTable, ConversationTable, MessageTable
from core.logging import get_context, get_logger
from core.security.internal_trust import internal_service_headers
from core.security.tls import get_httpx_client_cert, get_httpx_verify
from core.settings import settings
from engine.conversations.file_branches import FileBranch, run_file_branch
from engine.agents.service_urls import (
    build_conversation_documents_url,
    build_conversation_files_url,
)

logger = get_logger(__name__)

#: Where a deliverable is presented from, and what makes it a canvas document.
OUTPUT_PREFIX = "/conversation/output/"
DOCUMENT_SUFFIX = ".md"
#: The column's bound (``attachments.source_path``, migration 0049).
SOURCE_PATH_MAX_CHARS = 1024


def _source_path(path: Any) -> str | None:
    """The presented virtual path, kept only when it is one (under output/, bounded)."""
    if isinstance(path, str) and path.startswith(OUTPUT_PREFIX) and len(path) <= SOURCE_PATH_MAX_CHARS:
        return path
    return None


def canvas_document_paths(presented: list[dict[str, Any]]) -> list[str]:
    """The presented paths that are canvas documents: ``.md`` files under output/.

    A plain filter; the agents service validates each path again (normalised,
    no traversal) and skips any it does not accept.
    """
    found: list[str] = []
    for artifact in presented:
        path = _source_path(artifact.get("path"))
        if path and path.endswith(DOCUMENT_SUFFIX) and path not in found:
            found.append(path)
    return found


async def fetch_output_files(url: str, paths: list[str], branch: FileBranch) -> list[dict[str, Any]]:
    """The named files of the run's branch, base64. Paths the agent could not return are simply absent."""
    async with httpx.AsyncClient(
        timeout=settings.http.inference_timeout, verify=get_httpx_verify(), cert=get_httpx_client_cert()
    ) as client:
        resp = await client.get(
            url,
            params=[*branch.params().items(), *(("paths", path) for path in paths)],
            headers=internal_service_headers(get_context().get("request_id")),
        )
        resp.raise_for_status()
        files = resp.json().get("files")
    return [f for f in files if isinstance(f, dict)] if isinstance(files, list) else []


async def _store_fetched(
    db: AsyncSession, run: MessageTable, url: str, meta_by_path: dict[str, dict[str, Any]]
) -> tuple[int, int]:
    """Fetch the presented paths and add one generated attachment per file.
    Returns (stored, skipped)."""
    paths = list(meta_by_path)
    try:
        fetched = await fetch_output_files(url, paths, run_file_branch(run))
    except (httpx.HTTPError, ValueError) as exc:
        logger.warning("output_capture_batch_failed", "Could not fetch the presented files",
                       run_id=run.id, files=len(paths), error_type=type(exc).__name__)
        return 0, len(paths)
    stored = 0
    skipped = len(paths) - len(fetched)  # absent or over the agents' size cap
    for f in fetched:
        try:
            raw = base64.b64decode(f.get("base64", ""), validate=True)
        except (ValueError, TypeError):
            skipped += 1
            continue
        meta = meta_by_path.get(f.get("path"), {})
        db.add(
            AttachmentTable(
                message_id=run.id,
                file_name=f.get("filename") or str(f.get("path", "")).rsplit("/", 1)[-1] or "file",
                mime_type=f.get("mime") or "application/octet-stream",
                size_bytes=len(raw),
                origin="generated",
                title=meta.get("title") or None,
                summary=meta.get("summary") or None,
                presented=True,
                # The canvas finds the document's versions by this path.
                source_path=_source_path(f.get("path")),
                # From the bytes actually stored, not anyone's claim.
                content_sha256=hashlib.sha256(raw).hexdigest(),
                blob=BlobTable(data=raw),
            )
        )
        stored += 1
    return stored, skipped


async def capture_presented_files(
    db: AsyncSession,
    run: MessageTable,
    conversation: ConversationTable | None,
    presented: list[dict[str, Any]],
) -> None:
    """In the finalize transaction: the files the agent presented this run.

    Always stored on this answer, even when unchanged — the card matches an
    attachment on its own message. The rows commit with the caller's finalize.
    Fetched in batches of ``OUTPUT_CAPTURE_BATCH_FILES`` (the agents service
    returns at most that many per request).
    """
    meta_by_path = {a["path"]: a for a in presented if a.get("path")}
    if conversation is None or not meta_by_path:
        return
    url = build_conversation_files_url(str(conversation.user_id), str(run.conversation_id))
    paths, size = list(meta_by_path), settings.output_capture.batch_files
    stored = skipped = 0
    for start in range(0, len(paths), size):
        batch = {path: meta_by_path[path] for path in paths[start:start + size]}
        done, missed = await _store_fetched(db, run, url, batch)
        stored, skipped = stored + done, skipped + missed
    logger.info("presented_files_captured", "Stored the files the agent presented",
                run_id=run.id, captured=stored, skipped=skipped)


async def _has_canvas_documents(db: AsyncSession, conversation_id: str) -> bool:
    """Whether any answer of the conversation presented a ``.md`` (a canvas document).

    ``source_path`` names it since migration 0049; an older presented row has
    only its file name, so a presented ``*.md`` counts too. One indexed probe,
    so a conversation that never had a document costs the agents service no call.
    """
    found = await db.scalar(
        select(AttachmentTable.id)
        .join(MessageTable, MessageTable.id == AttachmentTable.message_id)
        .where(
            MessageTable.conversation_id == conversation_id,
            AttachmentTable.presented.is_(True),
            or_(
                AttachmentTable.source_path.like(f"{OUTPUT_PREFIX}%{DOCUMENT_SUFFIX}"),
                AttachmentTable.file_name.like(f"%{DOCUMENT_SUFFIX}"),
            ),
        )
        .limit(1)
    )
    return found is not None


async def capture_canvas_documents(
    db: AsyncSession,
    run: MessageTable,
    conversation: ConversationTable | None,
    presented: list[dict[str, Any]],
) -> None:
    """At finalize, after the snapshot: record the canvas documents' new versions.

    One call to the agents service's ``POST …/documents/capture`` with the
    presented ``.md`` paths under output/; the agents service also checks the
    conversation's existing documents for changes the run made without
    presenting them, then marks every document seen by the agent (plan 44
    4.3). Made when this run presented a document or the conversation already
    has one. Idempotent upstream (the same bytes add no version), so a retried
    finalize is harmless. Fail-open: a failure is logged and the run finalizes
    anyway — the canvas then records the file as v1 the first time it is
    opened, and the next turn's note may repeat an edit the agent already saw.
    """
    if conversation is None:
        return
    document_paths = canvas_document_paths(presented)
    if not document_paths and not await _has_canvas_documents(db, str(run.conversation_id)):
        return
    url = f"{build_conversation_documents_url(str(conversation.user_id), str(run.conversation_id))}/capture"
    try:
        async with httpx.AsyncClient(
            timeout=settings.http.agents_timeout, verify=get_httpx_verify(), cert=get_httpx_client_cert()
        ) as client:
            resp = await client.post(
                url,
                params=run_file_branch(run).params(),
                json={"paths": document_paths, "source_run_id": str(run.id)},
                headers=internal_service_headers(get_context().get("request_id")),
            )
            resp.raise_for_status()
            captured = resp.json().get("captured")
    except (httpx.HTTPError, ValueError, AttributeError) as exc:
        logger.warning("canvas_documents_capture_failed", "Could not record the presented documents' versions",
                       run_id=run.id, documents=len(document_paths), error_type=type(exc).__name__)
        return
    created = sum(1 for c in captured if isinstance(c, dict) and c.get("created")) if isinstance(captured, list) else 0
    logger.info("canvas_documents_captured", "Recorded the presented documents' versions",
                run_id=run.id, documents=len(document_paths), created=created)
