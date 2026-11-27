"""The canvas part of a stream's start (plan 44, Phase 4.3): the note and the scoped instruction.

Called by ``router/inference.py`` after the slash command is applied and
before the agent is built:

1. ``canvas_edit`` on the run context (Ask agent on a selection) is validated
   fail-closed — an invalid one, or one for an agent without a conversation
   filesystem, raises :class:`CanvasEditRefused` (the route's 422);
2. for a deep agent in a conversation, the seen markers name the documents
   the user edited since the agent's last turn, and their diffs become the
   turn's note, followed by each document's open comment threads (Phase
   4.4) and the user's pending suggestions (Phase 4.6, Suggesting mode —
   shown as not applied). **Fail-open**: a database error means a turn
   without that part of the note, never a failed run;
3. both go into the turn's user message (:func:`apply_canvas_turn`), and the
   documents are marked seen at their latest version — a document met for the
   first time is only marked, with no diff. A turn whose last message is a
   task notification keeps its markers, so the next user turn still gets the
   note.

Logs carry counts only — a path, a selection or a diff is the user's text.
"""
from __future__ import annotations

import asyncio
from collections.abc import Mapping
from typing import Any

from core.logging import get_logger
from harness.canvas import (
    CanvasEditRefused,
    apply_canvas_turn,
    parse_canvas_edit,
    render_edit_notes,
)
from harness.conversation_files.comments import DocumentCommentStore, DocumentOpenThreads
from harness.conversation_files.seen import DocumentSeenStore, TurnState
from harness.conversation_files.suggestions import DocumentSuggestionStore, PendingSuggestions
from harness.memory import get_memory_pool, has_memory_pool

logger = get_logger(__name__)


def _seen_store(branch: str) -> DocumentSeenStore:
    return DocumentSeenStore(get_memory_pool(), branch=branch)


def _comment_store(branch: str) -> DocumentCommentStore:
    return DocumentCommentStore(get_memory_pool(), branch=branch)


async def _open_comments(user_id: str, conversation_id: str, branch: str) -> list[DocumentOpenThreads]:
    """The branch's open comment threads, or none when they cannot be read (fail-open)."""
    if not has_memory_pool():
        return []
    try:
        return await _comment_store(branch).open_threads(user_id, conversation_id)
    except Exception:  # a note is never worth a failed run
        logger.warning("canvas_turn_comments_failed", "Could not read the canvas comments for the turn note",
                       exc_info=True)
        return []


def _suggestion_store(branch: str) -> DocumentSuggestionStore:
    return DocumentSuggestionStore(get_memory_pool(), branch=branch)


async def _pending_suggestions(user_id: str, conversation_id: str, branch: str) -> PendingSuggestions | None:
    """The branch's pending suggestion sets, or None when they cannot be read (fail-open)."""
    if not has_memory_pool():
        return None
    try:
        return await _suggestion_store(branch).pending(user_id, conversation_id)
    except Exception:  # a note is never worth a failed run
        logger.warning("canvas_turn_suggestions_failed",
                       "Could not read the canvas suggestions for the turn note", exc_info=True)
        return None


async def _turn_state(user_id: str, conversation_id: str, branch: str) -> TurnState | None:
    """The seen markers' view of this turn on the branch, or None when it cannot be read (fail-open)."""
    if not has_memory_pool():
        return None
    try:
        return await _seen_store(branch).turn_state(user_id, conversation_id)
    except Exception:  # a note is never worth a failed run
        logger.warning("canvas_turn_state_failed", "Could not read the canvas documents for the turn note",
                       exc_info=True)
        return None


async def prepare_canvas_turn(
    messages: list[Any], context: Mapping[str, Any] | None, *, deep_agent: bool, branch: str | None
) -> list[Any]:
    """``messages`` with this turn's canvas note and scoped instruction added.

    ``branch`` is the run's branch thread: the documents, comments and
    suggestions the note reads are that branch's. A run without one gets no
    note.

    Raises :class:`CanvasEditRefused` for an invalid ``canvas_edit``, or one
    sent to an agent that has no canvas documents (not a deep agent).
    """
    ctx = context or {}
    edit = parse_canvas_edit(ctx.get("canvas_edit"))
    if not deep_agent:
        if edit is not None:
            raise CanvasEditRefused("This agent cannot edit canvas documents.")
        return messages
    user_id, conversation_id = ctx.get("user_id"), ctx.get("conversation_id")
    state: TurnState | None = None
    comments: list[DocumentOpenThreads] = []
    suggestions: PendingSuggestions | None = None
    if isinstance(user_id, str) and user_id and isinstance(conversation_id, str) and conversation_id and branch:
        state, comments, suggestions = await asyncio.gather(_turn_state(user_id, conversation_id, branch),
                                                            _open_comments(user_id, conversation_id, branch),
                                                            _pending_suggestions(user_id, conversation_id, branch))
    notes = render_edit_notes(state.edits if state is not None else [], comments, suggestions)
    rewritten, users_turn = apply_canvas_turn(messages, notes=notes, edit=edit)
    if edit is not None and not users_turn:
        raise CanvasEditRefused("The canvas edit has no user message to go with.")
    if users_turn and state is not None and state.marks:
        try:
            marked = await _seen_store(str(branch)).mark_seen(str(user_id), str(conversation_id), state.marks)
        except Exception:  # fail-open: at worst the next turn repeats the note
            logger.warning("canvas_turn_mark_failed", "Could not mark the canvas documents seen",
                           exc_info=True)
        else:
            logger.info("canvas_turn_prepared", "Added the canvas note and request to the turn",
                        documents=len(state.marks), edited=len(state.edits), marked=marked,
                        commented=len(comments),
                        suggested=suggestions.total if suggestions is not None else 0,
                        has_note=bool(notes), has_edit=edit is not None)
    elif state is not None and state.marks:
        logger.info("canvas_turn_skipped", "Left the canvas markers for the next user turn",
                    documents=len(state.marks))
    return rewritten


__all__ = ["CanvasEditRefused", "prepare_canvas_turn"]
