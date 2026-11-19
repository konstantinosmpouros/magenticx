"""Ask agent on a canvas selection in the bridge (plan 44, Phase 4.3).

A user message may carry ``canvasEdit`` (schema/documents/canvas_edit.py): the passage of
one of the conversation's canvas documents the user wants changed, and how.
The bridge does three things with it:

* **checks it before anything commits** (:func:`check_canvas_edit`): only on a
  start into an existing conversation the caller owns (``send`` / ``edit``;
  a new conversation or a continued share cannot hold the document yet), the
  path must be the agents service's canonical form of a document that has
  versions in *this* conversation, and the version must exist. The agents
  service answers from rows filtered on the user and the conversation, so a
  path from another conversation is simply not found. A request started from
  a comment (``commentId``, plan 44 v2) must also name an **open thread** of
  this conversation on that same document — anything else is a 422
  ``{"code": "invalid_canvas_edit", "message": …}``;
* **refuses it where no run starts** (:func:`refuse_canvas_edit`): the plain
  message route and conversation create store a message without a run, so a
  canvas edit there would be a request nobody acts on;
* **carries it on the run context** (:func:`canvas_edit_context`), read back
  from the stored user message like ``command`` and ``effort``, so a retry
  asks for the same change. The agents service validates it again and turns
  it into that turn's scoped instruction.

Logs never carry the path, the selection or the instruction: all three are
the user's words.
"""
from __future__ import annotations

from typing import Any

from fastapi import HTTPException, status
from pydantic import ValidationError

from core.database import MessageTable
from core.logging import get_logger
from schema import CanvasEditIn, CanvasEditOut, MessageIn
from engine.documents.comments import get_document_comment
from engine.documents.documents import list_document_versions

logger = get_logger(__name__)

_NEEDS_CONVERSATION = "A canvas edit is sent in the conversation that holds the document."
_NOT_HERE = "A canvas edit is sent with a run, not as a plain message."
_NOT_FOUND = "That document is not in this conversation."
_BAD_VERSION = "That version of the document does not exist."
_NOT_CANONICAL = "That is not a document this conversation can open or save."
_THREAD_NOT_OPEN = "That comment thread is not open on this document."


def refuse_canvas_edit(message: MessageIn | None) -> None:
    """422 when a message that starts no run carries a canvas edit."""
    if message is not None and message.canvasEdit is not None:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=_NOT_HERE)


def refuse_without_conversation(message: MessageIn | None) -> None:
    """422 for a canvas edit on a start that creates its conversation (new, shared continue)."""
    if message is not None and message.canvasEdit is not None:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=_NEEDS_CONVERSATION)


async def check_canvas_edit(user_id: str, conversation_id: str, edit: CanvasEditIn) -> None:
    """Refuse a canvas edit that does not name a version of one of this conversation's documents.

    The caller has already established that ``conversation_id`` is the
    caller's (``validate_convId_full``). Asks the agents service for the
    document's newest version (``GET …/documents/versions?limit=1``):

    * 404 — the conversation has no such document (no versions);
    * 422 — not a canonical document path, or a version above the latest;
    * 503 / 502 — the agents service cannot answer (from ``engine.documents.documents``).

    With ``commentId`` it then reads that comment (``GET …/comments/{id}``,
    scoped to the user and the conversation): no such comment, a reply rather
    than a thread, a resolved thread or one on another document is a 422
    ``invalid_canvas_edit``.
    """
    history = await list_document_versions(user_id, conversation_id, edit.path, 1)
    if history.path != edit.path:
        # The agents service canonicalised it (``//``, a trailing ``/``): the
        # UI always sends the canonical path, so anything else is refused
        # rather than stored in a form the document is not known by.
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=_NOT_CANONICAL)
    if not history.versions:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=_NOT_FOUND)
    if edit.version > history.versions[0].version:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=_BAD_VERSION)
    if edit.commentId is not None:
        await _check_thread(user_id, conversation_id, edit)
    logger.info("canvas_edit_checked", "Checked a canvas edit against the conversation's document",
                conversation_id=conversation_id, version=edit.version,
                latest_version=history.versions[0].version, preset=edit.preset,
                from_comment=edit.commentId is not None)


async def _check_thread(user_id: str, conversation_id: str, edit: CanvasEditIn) -> None:
    """422 unless ``edit.commentId`` is an open thread of this conversation on ``edit.path``."""
    try:
        comment = await get_document_comment(user_id, conversation_id, str(edit.commentId))
    except HTTPException as exc:
        if exc.status_code != status.HTTP_404_NOT_FOUND:
            raise  # 503 / 502: the agents service could not answer
        comment = None
    if comment is None or comment.parentId is not None or comment.status != "open" or comment.path != edit.path:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail={"code": "invalid_canvas_edit", "message": _THREAD_NOT_OPEN},
        )


def canvas_edit_context(user_message: MessageTable | None) -> dict[str, Any]:
    """The run context's ``canvas_edit`` entry for the turn ``user_message`` starts, or ``{}``.

    snake_case like the rest of the run context. No key at all when the
    message carries none, so an ordinary run sends exactly the config it sent
    before; likewise ``comment_id`` is there only for a comment-started edit,
    so a plain Ask agent edit sends the exact shape it always did. A stored value that no longer fits the shape is dropped (fail
    closed): the run then is an ordinary turn on the message's content.
    """
    stored = getattr(user_message, "canvas_edit", None)
    if not isinstance(stored, dict) or not stored:
        return {}
    try:
        edit = CanvasEditOut.model_validate(stored)
    except ValidationError:
        logger.warning("canvas_edit_unreadable", "Dropped an unreadable stored canvas edit from the run")
        return {}
    context: dict[str, Any] = {
        "path": edit.path,
        "version": edit.version,
        "selection": edit.selection,
        "heading_path": list(edit.headingPath),
        "instruction": edit.instruction,
        "preset": edit.preset,
    }
    if edit.commentId is not None:
        context["comment_id"] = edit.commentId
    return {"canvas_edit": context}
