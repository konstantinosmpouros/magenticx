"""Find an agent's quote in a canvas document the way the canvas reads it (plan 44 v2).

The agent comments on a passage with ``add_comment(path, quote, body)``. The
thread it creates must anchor in the canvas exactly like a thread the user
made, and the canvas does not anchor against markdown: it anchors against the
*editor's text* — ``buildTextIndex`` in
``agentic_ui/src/features/canvas/lib/commentAnchors.ts``, every text of the
document in reading order with a newline between two blocks. A quote copied
from the markdown (``**Scope**``, ``[the brief](https://…)``) would never be
found there, and a thread the canvas cannot place is shown detached.

So this module mirrors that text from the markdown source
(:func:`reading_text`): it drops the syntax a reader never sees — heading
``#``, ``>``, list and task markers, ``*``/``_``/`` ` ``/``~~`` emphasis
marks, link and image syntax (a link keeps its text; an image, a void block
in the editor, keeps nothing), table pipes and separator rows (each cell is a
block), code fences, reference definitions — and keeps one block per line.
It is a mirror, not a markdown parser: the quote search is exact on the words,
and the prefix and suffix only rank occurrences in the canvas
(``locateAnchor``), so a small difference in the context costs nothing.

:func:`anchor_for` finds the quote (exactly, then tolerant of whitespace, then
with the quote's own markdown marks removed) and returns the anchor the UI
stores: the quote as it reads plus up to :data:`CONTEXT_CHARS` characters
either side.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

#: Context kept either side of the quote — the UI's ``CONTEXT_CHARS``.
CONTEXT_CHARS = 120

_FENCE = re.compile(r"^\s{0,3}(`{3,}|~{3,})")
_THEMATIC_BREAK = re.compile(r"^\s{0,3}([-*_])(?:\s*\1){2,}\s*$")
_SETEXT_UNDERLINE = re.compile(r"^\s{0,3}(?:=+|-+)\s*$")
_HEADING = re.compile(r"^#{1,6}(?:\s+|$)")
_HEADING_CLOSE = re.compile(r"\s+#+\s*$")
_BLOCKQUOTE = re.compile(r"^>\s?")
_LIST_MARKER = re.compile(r"^(?:[-*+]|\d{1,9}[.)])\s+(?:\[[ xX]\]\s+)?")
_TABLE_SEPARATOR = re.compile(r"^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$")
_REFERENCE_DEFINITION = re.compile(r"^\s{0,3}\[[^\]]+\]:\s*\S")
_UNESCAPED_PIPE = re.compile(r"(?<!\\)\|")

#: Backslash escapes of ASCII punctuation, as CommonMark defines them.
_ESCAPE = re.compile(r"\\([!-/:-@\[-`{-~])")
#: An escaped character is parked as a private-use code point while the marks
#: are stripped, so ``\*`` is never read as emphasis, then restored.
_PARK_BASE = 0xF0000
_PARKED = re.compile("[\U000f0021-\U000f007e]")
_CODE_SPAN = re.compile(r"(`+)(.+?)\1")
_CODE_SLOT = re.compile("\U000fff00(\\d+)\U000fff01")
_IMAGE = re.compile(r"!\[[^\]]*\](?:\([^)]*\)|\[[^\]]*\])")
_LINK = re.compile(r"\[([^\]]+)\](?:\([^)]*\)|\[[^\]]*\])")
_AUTOLINK = re.compile(r"<((?:https?|mailto):[^>\s]+)>")
_EMPHASIS = (
    re.compile(r"~~(.+?)~~"),
    re.compile(r"\*\*(.+?)\*\*"),
    re.compile(r"(?<!\w)__(.+?)__(?!\w)"),
    re.compile(r"(?<![\w*])\*(?![\s*])(.+?)(?<![\s*])\*(?![\w*])"),
    re.compile(r"(?<![\w_])_(?![\s_])(.+?)(?<![\s_])_(?![\w_])"),
)


@dataclass(frozen=True)
class FoundQuote:
    """Where the quote sits in the reading text: the anchor the canvas stores."""

    quote: str
    prefix: str
    suffix: str


def _inline(text: str) -> str:
    """One line's text without its inline marks (emphasis, code, links, images, escapes)."""
    text = _ESCAPE.sub(lambda m: chr(_PARK_BASE + ord(m.group(1))), text)
    spans: list[str] = []

    def _park_code(match: re.Match[str]) -> str:
        content = match.group(2)
        if len(content) > 1 and content.startswith(" ") and content.endswith(" "):
            content = content[1:-1]
        spans.append(content)
        return f"\U000fff00{len(spans) - 1}\U000fff01"

    text = _CODE_SPAN.sub(_park_code, text)
    text = _IMAGE.sub("", text)
    text = _LINK.sub(r"\1", text)
    text = _AUTOLINK.sub(r"\1", text)
    # Nested marks (``***both***``) come off one layer per pass.
    for _ in range(3):
        before = text
        for pattern in _EMPHASIS:
            text = pattern.sub(r"\1", text)
        if text == before:
            break
    text = _CODE_SLOT.sub(lambda m: spans[int(m.group(1))], text)
    return _PARKED.sub(lambda m: chr(ord(m.group(0)) - _PARK_BASE), text)


def _block_line(line: str) -> str:
    """A non-table, non-code line as the editor's block shows it."""
    text = line.strip()
    while _BLOCKQUOTE.match(text):
        text = _BLOCKQUOTE.sub("", text, count=1).lstrip()
    if _HEADING.match(text):
        text = _HEADING_CLOSE.sub("", _HEADING.sub("", text, count=1))
    else:
        text = _LIST_MARKER.sub("", text, count=1)
    return _inline(text.rstrip("\\").strip())


def _table_cells(line: str) -> list[str]:
    """A table row's cells, each one block of the editor."""
    cells = _UNESCAPED_PIPE.split(line.strip())
    if cells and not cells[0].strip():
        cells = cells[1:]
    if cells and not cells[-1].strip():
        cells = cells[:-1]
    return [_inline(cell.strip()) for cell in cells]


def reading_text(markdown: str) -> str:
    """The document's text as the canvas editor reads it: one block per line, no markdown syntax."""
    lines = markdown.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    out: list[str] = []
    fence: str | None = None
    in_table = False
    previous_was_text = False
    for index, line in enumerate(lines):
        if fence is not None:
            if line.strip().startswith(fence):
                fence = None
            else:
                out.append(line)  # a code line is a block, verbatim
            continue
        opening = _FENCE.match(line)
        if opening:
            fence = opening.group(1)[0] * len(opening.group(1))
            previous_was_text = False
            continue
        if not line.strip():
            in_table = previous_was_text = False
            continue
        following = lines[index + 1] if index + 1 < len(lines) else ""
        if in_table and _TABLE_SEPARATOR.match(line):
            continue  # the row under the header holds no text
        if "|" in line and (in_table or (_TABLE_SEPARATOR.match(following) and "-" in following)):
            in_table = True
            out.extend(_table_cells(line))
            previous_was_text = False
            continue
        in_table = False
        if previous_was_text and _SETEXT_UNDERLINE.match(line):
            previous_was_text = False  # the line above was a heading; its underline is no text
            continue
        if _THEMATIC_BREAK.match(line):
            out.append("")  # a rule is a void block: an empty text in the editor
            previous_was_text = False
            continue
        if _REFERENCE_DEFINITION.match(line):
            continue
        out.append(_block_line(line))
        previous_was_text = True
    return "\n".join(out)


def _span(text: str, quote: str) -> tuple[int, int] | None:
    """Where ``quote`` first occurs in ``text``: exactly, else with any run of whitespace between its words."""
    at = text.find(quote)
    if at != -1:
        return at, at + len(quote)
    words = quote.split()
    if not words:
        return None
    match = re.search(r"\s+".join(re.escape(word) for word in words), text)
    return (match.start(), match.end()) if match else None


def anchor_for(markdown: str, quote: str) -> FoundQuote | None:
    """The anchor of ``quote`` in a document's markdown, or None when the canvas text does not hold it.

    The quote is looked for as given and then with its own markdown marks
    removed (a model may copy ``**bold**`` from the file); the stored quote is
    always the canvas text it matched, so the UI finds it with a plain search.
    """
    text = reading_text(markdown)
    wanted = quote.strip()
    if not wanted:
        return None
    span = _span(text, wanted)
    if span is None:
        plain = _block_line(wanted)
        span = _span(text, plain) if plain and plain != wanted else None
    if span is None:
        return None
    start, end = span
    return FoundQuote(
        quote=text[start:end],
        prefix=text[max(0, start - CONTEXT_CHARS):start],
        suffix=text[end:end + CONTEXT_CHARS],
    )


__all__ = ["CONTEXT_CHARS", "FoundQuote", "anchor_for", "reading_text"]
