"""One-shot (plan 41 §3.7): the bridge sends every conversation branch so this
service imports their legacy checkpoint scratch files at boot.

**Delete with** ``harness/filesystem/scratch_migration.py`` and
``router/scratch_import.py`` in the release after it has run on Dennis.

The bridge knows which branch belongs to which conversation and user
(``messages.checkpoint_thread_id``); this service only holds the threads.
"""
from typing import Annotated, List

from pydantic import BaseModel, Field, StringConstraints

from schema.account import ThreadId

# A user or conversation id as the bridge sends it: a non-empty opaque token.
OwnerId = Annotated[str, StringConstraints(min_length=1, max_length=256)]


class LegacyScratchBranch(BaseModel):
    thread_id: ThreadId
    user_id: OwnerId
    conversation_id: OwnerId


class LegacyScratchImportRequest(BaseModel):
    """Bounded so one call stays one short job; the bridge sends batches."""

    branches: List[LegacyScratchBranch] = Field(default_factory=list, max_length=200)


class LegacyScratchImportResponse(BaseModel):
    branches: int
    files: int
