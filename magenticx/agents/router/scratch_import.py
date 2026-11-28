"""One-shot (plan 41 §3.7): import every branch's legacy checkpoint scratch files.

Before the scratch store, a deep agent's working files lived in the ``files``
key of its branch thread's graph state. ``scratch_migration`` imports them
lazily, the first time a branch is used, so a conversation nobody reopens kept
its files only in the checkpoints. At boot the bridge sends every branch it
knows (thread, user, conversation) here, in batches, and each is imported once
(the marker makes a second call a no-op).

**Delete this module** with ``schema/scratch_import.py`` and
``harness/filesystem/scratch_migration.py`` in the release after it has run on
Dennis — and the bridge's ``engine/conversations/legacy_scratch_import.py``.

Internal-caller only. Answers 503 while the checkpointer or the store is not
ready, or when any branch failed, so the bridge retries the same batch.
"""
from fastapi import APIRouter, Depends, HTTPException, status

from core.logging import get_logger
from core.security.internal_trust import require_internal_caller
from harness.checkpointer import has_checkpointer_initialized
from harness.filesystem import BranchScratchStore, layout, scratch_migration
from harness.filesystem.scratch_backend import checked_branch_thread_id
from harness.filesystem.scratch_store import ScratchScope
from harness.memory import has_memory_pool
from schema.scratch_import import LegacyScratchImportRequest, LegacyScratchImportResponse

logger = get_logger(__name__)

router = APIRouter()

#: Written as the rows' last writer: no agent wrote them on this branch.
IMPORT_AGENT_SLUG = "legacy-import"

_RETRY = "The legacy scratch import did not finish; retry it."


@router.post(
    "/internal/scratch/legacy-import",
    response_model=LegacyScratchImportResponse,
    dependencies=[Depends(require_internal_caller)],
)
async def import_legacy_scratch_branches(payload: LegacyScratchImportRequest) -> LegacyScratchImportResponse:
    """Import each branch's legacy scratch files once; never overwrites the store."""
    if not has_checkpointer_initialized() or not has_memory_pool():
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, _RETRY)
    store = BranchScratchStore()
    await store.ensure_setup()
    imported = failed = 0
    for branch in payload.branches:
        try:
            scope = ScratchScope(
                layout.safe_segment(branch.user_id),
                layout.safe_segment(branch.conversation_id),
                checked_branch_thread_id(branch.thread_id),
            )
        except ValueError:
            # An id this service would never key a row on: nothing to import.
            logger.warning("legacy_scratch_import_skipped", "Skipped a branch with an invalid id")
            continue
        try:
            imported += await scratch_migration.import_legacy_scratch(store, scope, agent_slug=IMPORT_AGENT_SLUG)
        except scratch_migration.IMPORT_ERRORS as exc:
            failed += 1
            logger.warning("legacy_scratch_import_failed", "Could not import a branch's legacy scratch files",
                           conversation_id=scope.conversation_id, error_type=type(exc).__name__)
    logger.info("legacy_scratch_import_batch", "Imported a batch of branches' legacy scratch files",
                branches=len(payload.branches), files=imported, failed=failed)
    if failed:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, _RETRY)
    return LegacyScratchImportResponse(branches=len(payload.branches), files=imported)
