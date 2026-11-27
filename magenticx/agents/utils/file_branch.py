"""Which branch of a conversation a bridge call about its files is for.

A conversation's files, canvas documents, comments and suggestions are kept
per branch (its checkpoint thread), so every internal route over them names
one: ``branch_thread_id``, which the bridge resolves from the message the user
is looking at, never from the browser. ``message_id`` is the answer a write
belongs to (the one on screen for a user save), recorded so a later fork cuts
the write where it was made.
"""
from __future__ import annotations

from dataclasses import dataclass

from fastapi import Query

from harness.conversation_files.store import ConversationFileStore
from harness.memory import get_memory_pool


@dataclass(frozen=True)
class FileBranch:
    """The branch a call reads and writes, and the answer its writes belong to."""

    thread_id: str
    message_id: str | None = None

    def store(self, store_class: type[ConversationFileStore]) -> ConversationFileStore:
        """A store of ``store_class`` bound to this branch and writer."""
        return store_class(get_memory_pool(), branch=self.thread_id, message_id=self.message_id)


def file_branch(
    # Empty: the legacy branch, the files kept from before branches.
    branch_thread_id: str = Query(max_length=128,
                                  description="The conversation branch (its checkpoint thread); empty for legacy."),
    message_id: str | None = Query(None, min_length=1, max_length=64,
                                   description="The answer a write belongs to."),
) -> FileBranch:
    """The route dependency: the branch from the query string."""
    return FileBranch(thread_id=branch_thread_id, message_id=message_id)


__all__ = ["FileBranch", "file_branch"]
