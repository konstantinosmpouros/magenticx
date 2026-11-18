"""Put the canvas text into the turn's user message.

The chat bubble shows what the user typed (the bridge stores it); only the
message the model receives is rewritten, as the slash commands do
(:mod:`harness.commands.render`):

* the per-turn note, if any, goes first;
* with an Ask agent request, its scoped instruction *replaces* the text —
  the message's content is the instruction the scoped text already quotes;
* otherwise the user's own text follows the note, introduced as theirs.

Only the last user message is touched, and never a background task's
notification (it replays as the exact message the async middleware wrote, and
its text is not the user's). Image parts stay as they are.
"""
from __future__ import annotations

from typing import Any

from harness.async_tasks.notification import is_notification_payload
from harness.canvas.edit import CanvasEdit, render_canvas_edit

_USER_FOLLOWS = "The user's message follows."


def _text_of(content: Any) -> tuple[str, list[Any]]:
    """A message's text and its non-text parts (images)."""
    if isinstance(content, list):
        text = "\n".join(
            str(part.get("text", "")) for part in content if isinstance(part, dict) and part.get("type") == "text"
        )
        others = [part for part in content if not (isinstance(part, dict) and part.get("type") == "text")]
        return text, others
    return str(content or ""), []


def compose_turn_text(user_text: str, *, notes: str, edit: CanvasEdit | None) -> str:
    """The text the model gets for this turn."""
    body = render_canvas_edit(edit) if edit is not None else user_text
    if not notes:
        return body
    if edit is not None:
        return f"{notes}\n\n{body}"
    return f"{notes}\n\n{_USER_FOLLOWS}\n\n{body}"


def _user_turn_index(messages: list[Any]) -> int | None:
    """The index of the turn's user message, or None when the turn has none the
    user wrote (no user message, or the last one is a task notification)."""
    for index in range(len(messages) - 1, -1, -1):
        message = messages[index]
        if not isinstance(message, dict) or message.get("role") != "user":
            continue
        return None if is_notification_payload(message) else index
    return None


def apply_canvas_turn(
    messages: list[Any], *, notes: str, edit: CanvasEdit | None
) -> tuple[list[Any], bool]:
    """``messages`` with the turn's user message rewritten, and whether the turn is the user's.

    The flag is True when there is a user message to speak to — whether or
    not anything was added to it — and False for a turn without one (a task
    notification's wake-up): the caller then leaves the seen markers where
    they were, so the note waits for the next user turn instead of being lost.
    """
    index = _user_turn_index(messages)
    if index is None:
        return list(messages), False
    if not notes and edit is None:
        return list(messages), True
    message = messages[index]
    text, others = _text_of(message.get("content"))
    rewritten_text = compose_turn_text(text, notes=notes, edit=edit)
    content: Any = rewritten_text
    if isinstance(message.get("content"), list):
        content = [{"type": "text", "text": rewritten_text}, *others]
    return [*messages[:index], {**message, "content": content}, *messages[index + 1:]], True


__all__ = ["apply_canvas_turn", "compose_turn_text"]
