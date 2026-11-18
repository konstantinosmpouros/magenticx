"""When the agent makes a canvas document, when a file, and when it just answers.

Plan 44 §3 (decided 2026-11-18, "the same as Anthropic"): the format the user
names decides. A named Office format or PDF is that real file, built and
checked in the sandbox with the platform skill; "a document" with no format is
a canvas document — a markdown file the user opens and edits beside the chat;
anything else is a reply in the chat, however long. Neither a file nor a
document on the agent's own initiative.

The second half is how to *edit* a canvas document (Phase 4.3): the user edits
it too, so a local request is a targeted ``edit_file`` on the exact text,
never a rewrite that would throw their changes away. The turn tells the agent
what the user changed (the per-turn note, ``harness.canvas``); this says what
to do about it.

This is the one statement of the rule — the platform verbs section only says
how to present a file. Gated on a conversation (the mounts and
``present_artifact`` exist only with one); the named-format line depends on the
sandbox, since without ``execute`` no real Office file or PDF can be built.
"""
from __future__ import annotations

from harness.prompt_engineering.context import PromptContext

_HEADER = "## Documents, Files and the Chat"

_INTRO = """\
The format the user names decides what you make. Make a file or a document
only when the user asks for one — never on your own initiative."""

_NAMED_FORMAT_SANDBOX = """\
- **A named format** — Word / `.docx`, Excel / `.xlsx`, PowerPoint / `.pptx`,
  PDF: make that real file straight away{skill} in the sandbox. Render it and
  check it, write it to `/conversation/output/`, then present it. No canvas
  document."""

#: Only when ``/platform_skills/`` is mounted (every deep agent's, plan 44).
_SKILL = ", with the matching platform skill (read its\n  `SKILL.md` under `/platform_skills/` first),"

_NAMED_FORMAT_NO_SANDBOX = """\
- **A named format** — Word / `.docx`, Excel / `.xlsx`, PowerPoint / `.pptx`,
  PDF: this run has no sandbox to build one in. Say so plainly and offer a
  canvas document instead; never pass off another format as the one asked for."""

_RULES = """\
- **"A document", "a doc", "a draft", "in a canvas"** — the user asks for a
  document and names no format: make a canvas document, a markdown file (`.md`)
  in `/conversation/output/`, and present it with `present_artifact`. The user
  opens it beside the chat and edits it there.
- **Anything else**, however long — an answer, an explanation, a report
  written in the reply: answer in the chat. No file and no document.
- **Editing a canvas document** — the user edits it too, and the file always
  holds their latest text. For a change to one part, use `edit_file` on the
  exact text of that part; never rewrite the whole document for a local
  request, and keep every change the user made since your last turn (the turn
  tells you what they changed). After an edit, say in a sentence or two what
  you changed instead of repeating the document. A document you changed does
  not need presenting again; present it again only when the user asks for it."""


def documents_prompt(context: PromptContext) -> str:
    """The document routing rule for this run. Empty without a conversation."""
    if not context.has_conversation:
        return ""
    if context.sandbox_enabled:
        named = _NAMED_FORMAT_SANDBOX.format(skill=_SKILL if context.has_platform_skills else "")
    else:
        named = _NAMED_FORMAT_NO_SANDBOX
    return f"{_HEADER}\n\n{_INTRO}\n\n{named}\n{_RULES}"


__all__ = ["documents_prompt"]
