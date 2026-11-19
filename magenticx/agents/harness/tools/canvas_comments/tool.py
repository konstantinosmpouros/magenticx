"""Agent tools: answer and add comments on a canvas document (plan 44 v2).

Comments are the user's instruction channel on a passage: the user marks the
text, writes what they want, and — with ``@agent`` — asks the agent to act.
These two tools are how the agent answers in the same place:

* ``reply_to_comment(thread_id, body)`` — a reply (``author='agent'``) under
  an open thread;
* ``add_comment(path, quote, body)`` — a new thread on a passage of the
  document's latest version, for an assumption or a question while drafting.
  The quote is found in the canvas text (:mod:`harness.conversation_files.anchors`),
  so it anchors where the user sees it.

**The agent never resolves a thread.** Resolving is the user's call: the
agent acts on the request and replies; the user closes the thread once the
passage reads as they wanted.

**Scope.** Bound per run to the run's own user and conversation, read from the
run config by the agent (``NativeToolContext``) — never from a tool argument —
and every store statement filters on both, so a thread id from anywhere else
is simply not found. **Attached** only when the conversation has at least one
canvas document (the same rows the per-turn canvas note reads), and never to a
background task's run: the orchestrator talks to the user. **Not HITL-gated**:
a comment is not a document edit and nothing leaves the conversation. Instead
it is **bounded**: at most :data:`MAX_COMMENT_WRITES_PER_RUN` writes per run,
counted by a :class:`CommentWriteBudget` the agent instance owns (one per run).

Every refusal is a short string the model can act on — a missing or resolved
thread, another conversation's id, a quote not in the document, the limits —
in the ``Could not …:`` form the other tools use; nothing raises out of the
graph for a wrong call (an unexpected database error still reaches
``ToolErrorMiddleware``, which turns it into an error result). Logs carry
counts and outcomes only: a comment is the user's (or the agent's) words.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass

from langchain_core.tools import StructuredTool
from pydantic import BaseModel, Field

from core.logging import get_logger
from harness.conversation_files.comments import (
    CommentLimitReached,
    CommentNotFound,
    DocumentCommentStore,
    InvalidComment,
    QuoteNotFound,
    ThreadNotOpen,
)
from harness.conversation_files.versions import DocumentNotFound, InvalidDocumentPath, document_path
from harness.memory import get_memory_pool
from harness.tools.text_args import undo_double_escaping

logger = get_logger(__name__)

REPLY_TOOL_NAME = "reply_to_comment"
ADD_TOOL_NAME = "add_comment"

#: Comment writes (replies, new threads) one run may make.
MAX_COMMENT_WRITES_PER_RUN = 10
#: The tools' own bounds (tighter than the store's): a reply or a new
#: comment, a quote.
MAX_BODY_CHARS = 2000
MAX_QUOTE_CHARS = 300

_LIMIT_REACHED = (
    f"you have made the {MAX_COMMENT_WRITES_PER_RUN} comment changes allowed in one turn. "
    f"Tell the user the rest in the chat instead."
)
_NO_THREAD = "there is no comment thread with that id in this conversation."


class CommentWriteBudget:
    """How many comment writes this run has left. One per agent instance, so one per run.

    The check and the count are one synchronous step, so two calls the model
    makes in parallel cannot both take the last write.
    """

    def __init__(self, limit: int = MAX_COMMENT_WRITES_PER_RUN) -> None:
        self._left = limit

    def take(self) -> bool:
        """Spend one write; False when none is left."""
        if self._left <= 0:
            return False
        self._left -= 1
        return True


@dataclass(frozen=True)
class _RunScope:
    """Whose comments a run's tools touch: from the run config, never from the model."""

    user_id: str
    conversation_id: str
    run_id: str | None


def _store() -> DocumentCommentStore:
    return DocumentCommentStore(get_memory_pool())


def _thread_id(value: str) -> str | None:
    """The canonical form of a thread id, or None when it is not one."""
    try:
        return str(uuid.UUID((value or "").strip()))
    except ValueError:
        return None


def _text_problem(name: str, value: str | None, limit: int, *, required: bool = True) -> str | None:
    """Why a text argument cannot be written, or None."""
    if value is None or not value.strip():
        return f"'{name}' is empty." if required else None
    if "\x00" in value:
        return f"'{name}' holds a NUL character."
    if len(value) > limit:
        return f"'{name}' is too long ({len(value)} characters; at most {limit})."
    return None


def _refusal(exc: Exception) -> str:
    """The model-facing reason for a store refusal."""
    if isinstance(exc, CommentNotFound):
        return _NO_THREAD
    if isinstance(exc, ThreadNotOpen):
        return "that comment thread is already resolved."
    if isinstance(exc, QuoteNotFound):
        return "That quote is not in the document; copy the words exactly as they read."
    if isinstance(exc, CommentLimitReached):
        return f"{exc} Answer in the chat instead."
    if isinstance(exc, DocumentNotFound):
        return "there is no canvas document at that path in this conversation."
    return str(exc)


class _ReplyArgs(BaseModel):
    thread_id: str = Field(description="The id of the open comment thread, as the turn's canvas note lists it.")
    body: str = Field(description=f"Your reply, 1 to {MAX_BODY_CHARS} characters: one or two sentences on "
                                  "what you changed, or why you did not.")


class _AddArgs(BaseModel):
    path: str = Field(description="The canvas document, e.g. '/conversation/output/brief.md'.")
    quote: str = Field(description=f"The passage the comment is on, 1 to {MAX_QUOTE_CHARS} characters, copied "
                                   "exactly as it reads in the document — words only, no markdown marks "
                                   "(no '#', '**', '-', link syntax).")
    body: str = Field(description=f"The comment, 1 to {MAX_BODY_CHARS} characters: an assumption you made or "
                                  "a question about this passage.")


_BUDGET_NOTE = (f" Comment writes are limited to {MAX_COMMENT_WRITES_PER_RUN} per turn across "
                f"{REPLY_TOOL_NAME} and {ADD_TOOL_NAME}.")


def build_reply_to_comment_tool(
    *, user_id: str, conversation_id: str, budget: CommentWriteBudget
) -> StructuredTool:
    """``reply_to_comment`` bound to this run's conversation and write budget."""
    scope = _RunScope(user_id=user_id, conversation_id=conversation_id, run_id=None)

    async def _reply(thread_id: str, body: str) -> str:
        thread = _thread_id(thread_id)
        if thread is None:
            return f"Could not reply: {_NO_THREAD}"
        body = undo_double_escaping(body or "")
        if problem := _text_problem("body", body, MAX_BODY_CHARS):
            return f"Could not reply: {problem}"
        if not budget.take():
            return f"Could not reply: {_LIMIT_REACHED}"
        try:
            await _store().agent_reply(scope.user_id, scope.conversation_id, thread, body=body.strip())
        except (CommentNotFound, InvalidComment) as exc:
            logger.info("canvas_comment_tool_refused", "Refused an agent comment write",
                        tool=REPLY_TOOL_NAME, reason=type(exc).__name__)
            return f"Could not reply: {_refusal(exc)}"
        logger.info("canvas_comment_tool_written", "The agent replied to a comment thread",
                    tool=REPLY_TOOL_NAME, conversation_id=scope.conversation_id)
        return "Replied in the thread; the user sees it on the passage in the canvas."

    return StructuredTool.from_function(
        coroutine=_reply,
        name=REPLY_TOOL_NAME,
        description=(
            "Reply in a comment thread on a canvas document. Comments are the user's requests about a "
            "passage; after acting on one (or deciding not to), answer it here in one or two sentences — "
            "what you changed, or why you did not. Never resolve the thread: the user does. The thread id "
            "is in the turn's canvas note." + _BUDGET_NOTE
        ),
        args_schema=_ReplyArgs,
    )


def build_add_comment_tool(
    *, user_id: str, conversation_id: str, run_id: str | None, budget: CommentWriteBudget
) -> StructuredTool:
    """``add_comment`` bound to this run's conversation and write budget."""
    scope = _RunScope(user_id=user_id, conversation_id=conversation_id, run_id=run_id)

    async def _add(path: str, quote: str, body: str) -> str:
        try:
            canonical = document_path((path or "").strip())
        except InvalidDocumentPath:
            return "Could not comment: a canvas document is a .md file under /conversation/output/."
        body = undo_double_escaping(body or "")
        for name, value, limit in (("quote", quote, MAX_QUOTE_CHARS), ("body", body, MAX_BODY_CHARS)):
            if problem := _text_problem(name, value, limit):
                return f"Could not comment: {problem}"
        if not budget.take():
            return f"Could not comment: {_LIMIT_REACHED}"
        store = _store()
        try:
            # The latest version must hold what the agent wrote this run, or a
            # quote from its own draft would not be found: record the file as
            # the agent's version first, exactly as the run-end capture would
            # (idempotent — an unchanged file adds nothing).
            await store.capture(scope.user_id, scope.conversation_id, [canonical], run_id=scope.run_id)
            await store.agent_thread(scope.user_id, scope.conversation_id, canonical,
                                     quote=quote.strip(), body=body.strip())
        except (DocumentNotFound, InvalidComment) as exc:
            logger.info("canvas_comment_tool_refused", "Refused an agent comment write",
                        tool=ADD_TOOL_NAME, reason=type(exc).__name__)
            return f"Could not comment: {_refusal(exc)}"
        logger.info("canvas_comment_tool_written", "The agent added a comment thread",
                    tool=ADD_TOOL_NAME, conversation_id=scope.conversation_id)
        return "Added the comment on that passage; the user sees it in the canvas."

    return StructuredTool.from_function(
        coroutine=_add,
        name=ADD_TOOL_NAME,
        description=(
            "Leave a new comment on a passage of a canvas document — sparingly, while drafting or editing, "
            "to flag an assumption you made or ask the user a question about that specific passage. Never "
            "to chat, to summarise your work, or for anything you would say in the reply. 'quote' is the "
            "passage's words exactly as they read in the document, without markdown marks." + _BUDGET_NOTE
        ),
        args_schema=_AddArgs,
    )


__all__ = [
    "ADD_TOOL_NAME",
    "MAX_COMMENT_WRITES_PER_RUN",
    "REPLY_TOOL_NAME",
    "CommentWriteBudget",
    "build_add_comment_tool",
    "build_reply_to_comment_tool",
]
