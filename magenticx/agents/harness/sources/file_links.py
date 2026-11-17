"""Citation markers in a file the agent writes, turned into ordinary links.

``[src:ID]`` markers are a chat device: the chat turns them into citation
links that resolve against the conversation's sources. A file the agent writes
(``write_file`` / ``edit_file``) leaves the chat — it is downloaded, opened in
an editor, shared — so a marker there would stay raw text nobody can follow.
Before such a file is written, each marker becomes a markdown link to its page:
``grew 12% [src:3fa2c1].`` → ``grew 12% ([imf.org](https://www.imf.org/…)).``

Only ids a tool really returned resolve (the same rule as in the chat); an
unknown id is dropped, never printed. Markers inside code (fenced blocks and
inline spans) are left as written.
"""
from __future__ import annotations

import re
from collections.abc import Mapping
from urllib.parse import urlsplit

from harness.sources.model import Source

#: The marker the agent writes (shared contract with the bridge and the UI),
#: with the whitespace before it, which goes with it.
MARKER_RE = re.compile(r"[ \t]*\[src:\s*([0-9a-f]{6,8}(?:\s*,\s*[0-9a-f]{6,8})*)\s*\]")

#: Fenced code blocks and inline code spans, which keep their markers.
_CODE_RE = re.compile(r"```.*?(?:```|$)|`[^`\n]*`", re.DOTALL)

#: The text argument each file tool writes.
FILE_TEXT_ARGS: Mapping[str, str] = {"write_file": "content", "edit_file": "new_string"}


def has_markers(text: object) -> bool:
    """Whether ``text`` carries at least one citation marker."""
    return isinstance(text, str) and MARKER_RE.search(text) is not None


def marker_ids(text: str) -> set[str]:
    """Every id the text's markers name (code included; resolution skips code)."""
    return {raw.strip() for match in MARKER_RE.finditer(text) for raw in match.group(1).split(",")}


def _host(url: str) -> str:
    host = urlsplit(url).hostname or url
    return host[4:] if host.startswith("www.") else host


def _escape_label(text: str) -> str:
    """A link label that cannot close the link early."""
    return text.replace("\\", "\\\\").replace("[", "\\[").replace("]", "\\]")


def markers_to_links(text: str, sources: Mapping[str, Source]) -> str:
    """``text`` with each marker replaced by markdown links to its pages.

    One source → `` ([host](url))``; several → `` ([a](u1); [b](u2))``. A marker
    with no known id disappears together with the space before it, and so does a
    source whose page the paragraph already links (the agent wrote the link and
    the marker both).
    """

    def replace(segment: str) -> str:
        def one(match: re.Match[str]) -> str:
            paragraph = segment[segment.rfind("\n\n", 0, match.start()) + 1:match.start()]
            links = []
            for raw in match.group(1).split(","):
                source = sources.get(raw.strip())
                if source is not None and source.url.rstrip("/") not in paragraph:
                    links.append(f"[{_escape_label(_host(source.url))}]({source.url})")
            return f" ({'; '.join(links)})" if links else ""

        return MARKER_RE.sub(one, segment)

    parts: list[str] = []
    last = 0
    for code in _CODE_RE.finditer(text):
        parts.append(replace(text[last:code.start()]))
        parts.append(code.group(0))
        last = code.end()
    parts.append(replace(text[last:]))
    return "".join(parts)


def file_text_arg(call: Mapping[str, object]) -> str | None:
    """The argument of a file-writing tool call that carries markers, if any."""
    arg = FILE_TEXT_ARGS.get(str(call.get("name")))
    args = call.get("args")
    if arg and isinstance(args, Mapping) and has_markers(args.get(arg)):
        return arg
    return None


def linked_call(call: dict, sources: Mapping[str, Source]) -> dict | None:
    """``call`` with its file text's markers turned into links; ``None`` when
    there is nothing to change (not a file tool, no markers, same text)."""
    arg = file_text_arg(call)
    if arg is None:
        return None
    text = call["args"][arg]
    linked = markers_to_links(text, sources)
    if linked == text:
        return None
    return {**call, "args": {**call["args"], arg: linked}}


__all__ = [
    "FILE_TEXT_ARGS", "MARKER_RE", "file_text_arg", "has_markers", "linked_call", "marker_ids", "markers_to_links",
]
