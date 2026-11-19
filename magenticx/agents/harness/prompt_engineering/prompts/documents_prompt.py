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

Plan 44 v2 adds how to treat the user's **comments** — their instructions on
a passage, answered with the comment tools — and their pending
**suggestions** (Suggesting mode, accepted or rejected with
``review_suggestions`` only when the user asks), but only when those tools are
attached (``has_canvas_comments``: the conversation has a canvas document).

This is the one statement of the rule — the platform verbs section only says
how to present a file. Gated on a conversation (the mounts and
``present_artifact`` exist only with one); the named-format line depends on the
sandbox, since without ``execute`` no real Office file or PDF can be built.
"""
from __future__ import annotations

from harness.prompt_engineering.context import PromptContext
from harness.tools.canvas_comments import MAX_COMMENT_WRITES_PER_RUN

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

#: Plan 44 v2 — only when the comment tools are attached (``has_canvas_comments``).
_COMMENTS = f"""\
### Comments on canvas documents

The user leaves comments on passages of a canvas document; each turn lists
the open threads with their ids. A comment is the user's instruction about
that passage.
- To see resolved threads, or more than the turn lists, read them with
  `list_comments` (`status`: open, resolved or all; `path` for one document).
- Act on a thread when you work on its document, or when the turn asks you
  to. Then answer it with `reply_to_comment` — one or two sentences on what
  you changed, or why you did not.
- You never resolve a thread; the user does, once the passage reads as they
  wanted. There is no tool for it, so do not say you resolved or closed one.
- Use `add_comment` sparingly, while drafting or editing, to flag an
  assumption you made or ask a question about one specific passage. Quote the
  passage's words exactly as they read in the document, without markdown
  marks. Never use comments to chat, to summarise your work, or for anything
  you would say in the reply.
- At most {MAX_COMMENT_WRITES_PER_RUN} comment writes per turn.

### The user's suggestions on canvas documents

In the canvas's Suggesting mode the user's own edits are kept as pending
suggestions; the turn shows them, not applied. Use `review_suggestions`
ONLY when the user explicitly asks you to accept / apply or reject / remove
their suggestions — never on your own initiative, and never because the
suggestions look right or wrong to you. `accept` writes them into the
document as your edit; `reject` discards them and leaves the document as it
is. If it says they were made on an older version, ask the user to review
them in the canvas; do not merge them yourself. After it, say in one line
what happened."""


def documents_prompt(context: PromptContext) -> str:
    """The document routing rule for this run. Empty without a conversation.

    With the canvas tools attached (plan 44 v2), a block on how to treat
    comments and one on the user's pending suggestions follow the rules.
    """
    if not context.has_conversation:
        return ""
    if context.sandbox_enabled:
        named = _NAMED_FORMAT_SANDBOX.format(skill=_SKILL if context.has_platform_skills else "")
    else:
        named = _NAMED_FORMAT_NO_SANDBOX
    text = f"{_HEADER}\n\n{_INTRO}\n\n{named}\n{_RULES}"
    if context.has_canvas_comments:
        text = f"{text}\n\n{_COMMENTS}"
    return text


__all__ = ["documents_prompt"]
