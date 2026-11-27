"""Agent tool: accept or reject the user's pending suggestions on a canvas document.

In the canvas's Suggesting mode the user's own edits are saved as one pending
suggestion set per document (:mod:`harness.conversation_files.suggestions`):
the proposed full text on the version it was made on. The turn's canvas note
shows the agent that set as data. ``review_suggestions(path, decision)`` lets
the agent act on it — **only when the user asks it to** (the prompt and the
note's lead say so; the tool cannot tell, so the rule is stated where the
model reads it):

* ``reject`` — the set is deleted. No version, no file change.
* ``accept`` — only when the set was made on the document's latest version
  **and** the file still holds that version's text (the agent did not edit
  it earlier this turn). The proposed text is then written into the
  document's file through the run's own conversation files
  (:meth:`ConversationFiles.edit` — the very read-modify-write ``edit_file``
  uses, with the run's agent slug and run id), so the bridge's run-end
  capture records it as the **agent's** next version (the canvas shines the
  change, the seen markers move as after any agent edit); then the set it
  applied is deleted. A set made on an older version is never merged here:
  the agent is told to ask the user to review it in the canvas, where the
  rebase is shown to them.

The file write is compare-and-swap under the file row's lock: the transform
writes only when the bytes still read as the base version, so a user save or
an agent edit that landed after the version check is never overwritten.

**Scope.** Bound per run to the run's user and conversation through the
run's :class:`ConversationFiles` (built from the run config, never from a tool
argument); every store statement filters on both. **Attached** under the
comment tools' gate (a user's conversation with a canvas document, not a
background task). **Not HITL-gated** and **not counted** against the comment
write budget: it touches only the user's own suggestions on a document of
their conversation, and it runs on their explicit request.

Every refusal is a ``Could not …:`` string the model can act on; nothing
raises out of the graph for a wrong call. Logs carry the decision and the
outcome only — never a path or a byte of the text (the user's words).
"""
from __future__ import annotations

from typing import Literal

from langchain_core.tools import StructuredTool
from pydantic import BaseModel, Field

from core.logging import get_logger
from harness.canvas.fence import document_name
from harness.conversation_files import ConversationFiles
from harness.conversation_files.suggestions import DocumentSuggestionStore
from harness.conversation_files.versions import (
    MAX_DOCUMENT_BYTES,
    DocumentNotFound,
    InvalidDocumentPath,
    document_path,
)

logger = get_logger(__name__)

REVIEW_TOOL_NAME = "review_suggestions"

_VERB: dict[str, str] = {"accept": "apply", "reject": "reject"}
_BAD_PATH = "a canvas document is a .md file under /conversation/output/."
_NONE_PENDING = "There are no pending suggestions on that document."
_NO_DOCUMENT = "there is no canvas document at that path in this conversation."
_ASK_THE_USER = "Do not merge them yourself: ask the user to review them in the canvas."


def _store(files: ConversationFiles) -> DocumentSuggestionStore:
    """The suggestion store of the run's branch."""
    return files.store.sibling(DocumentSuggestionStore)


def _text(data: bytes) -> str:
    """File bytes as the versions read them (invalid UTF-8 as the replacement character)."""
    return data.decode("utf-8", errors="replace")


class _ReviewArgs(BaseModel):
    path: str = Field(description="The canvas document, e.g. '/conversation/output/brief.md'.")
    decision: Literal["accept", "reject"] = Field(
        description="'accept' applies the user's pending suggestions to the document; 'reject' discards them.")


def build_review_suggestions_tool(*, files: ConversationFiles) -> StructuredTool:
    """``review_suggestions`` bound to this run's conversation files (its user, conversation, slug and run)."""
    user_id, conversation_id = files.user_id, files.conversation_id

    async def _reject(canonical: str, name: str) -> str:
        if not await _store(files).delete(user_id, conversation_id, canonical):
            return f"Could not reject the suggestions: {_NONE_PENDING}"
        logger.info("canvas_suggestions_reviewed", "The agent rejected the user's pending suggestions",
                    tool=REVIEW_TOOL_NAME, decision="reject")
        return f"Rejected the user's suggestions on {name}; the document is unchanged."

    async def _accept(canonical: str, name: str) -> str:
        store = _store(files)
        pending = await store.get(user_id, conversation_id, canonical)
        if pending is None:
            return f"Could not apply the suggestions: {_NONE_PENDING}"
        try:
            latest = await store.latest(user_id, conversation_id, canonical)
        except DocumentNotFound:
            return f"Could not apply the suggestions: {_NO_DOCUMENT}"
        if latest.version != pending.base_version:
            return (f"Could not apply the suggestions: they were made on v{pending.base_version} and the "
                    f"document is now at v{latest.version}. {_ASK_THE_USER}")
        proposed = pending.content.encode("utf-8")
        if len(proposed) > MAX_DOCUMENT_BYTES:  # bounded at save; a cap that moved since must still hold
            return f"Could not apply the suggestions: the result is over the {MAX_DOCUMENT_BYTES} byte document limit."
        base_text = latest.content or ""
        moved: list[bool] = []

        def transform(raw: bytes) -> bytes | None:
            # Compare-and-swap under the row lock: only over the base version's text.
            if _text(raw) != base_text:
                moved.append(True)
                return None
            return proposed

        if not await files.edit(canonical, transform):
            return f"Could not apply the suggestions: {_NO_DOCUMENT}"
        if moved:
            logger.info("canvas_suggestions_review_refused", "The document changed after the suggestions",
                        tool=REVIEW_TOOL_NAME, decision="accept", reason="file_changed")
            return ("Could not apply the suggestions: the document changed after they were made "
                    f"(it was edited this turn). {_ASK_THE_USER}")
        # Only the set this call applied: one the user saved again meanwhile stays theirs.
        await store.delete(user_id, conversation_id, canonical, saved_at=pending.updated_at)
        logger.info("canvas_suggestions_reviewed", "The agent applied the user's pending suggestions",
                    tool=REVIEW_TOOL_NAME, decision="accept", size_bytes=len(proposed))
        return f"Applied the user's suggestions to {name}."

    async def _review(path: str, decision: str) -> str:
        verb = _VERB.get(decision, "review")
        try:
            canonical = document_path((path or "").strip())
        except InvalidDocumentPath:
            return f"Could not {verb} the suggestions: {_BAD_PATH}"
        if decision not in _VERB:
            return "Could not review the suggestions: 'decision' is 'accept' or 'reject'."
        name = document_name(canonical)
        if decision == "reject":
            return await _reject(canonical, name)
        return await _accept(canonical, name)

    return StructuredTool.from_function(
        coroutine=_review,
        name=REVIEW_TOOL_NAME,
        description=(
            "Accept or reject the user's pending suggestions on a canvas document (the edits they made in "
            "the canvas's Suggesting mode, shown in the turn's canvas note). ONLY when the user explicitly "
            "asks you to accept / apply or reject / remove their suggestions — never on your own initiative. "
            "'accept' writes them into the document as your edit; 'reject' discards them and leaves the "
            "document as it is. Suggestions made on an older version cannot be accepted here: ask the user "
            "to review them in the canvas. Afterwards, say in one line what happened."
        ),
        args_schema=_ReviewArgs,
    )


__all__ = ["REVIEW_TOOL_NAME", "build_review_suggestions_tool"]
