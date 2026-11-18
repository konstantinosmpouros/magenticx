"""The one escaping rule for user text placed inside the canvas markers.

Every marker the canvas text uses starts ``<canvas_``. Replacing that prefix
(and its closing form) in the user's text means no selection, heading,
instruction or document line can close a marker early and continue in the
platform's voice. Done in one place so the notes and the scoped instruction
can never disagree on it.
"""
from __future__ import annotations

from pathlib import PurePosixPath


def fence_safe(text: str) -> str:
    """``text`` with every ``<canvas_`` / ``</canvas_`` neutralised."""
    return text.replace("</canvas_", "&lt;/canvas_").replace("<canvas_", "&lt;canvas_")


def inline_code(text: str) -> str:
    """``text`` safe inside a pair of backticks in a sentence: no backtick, no line break."""
    return "".join(" " if ch in "`\r\n" else ch for ch in text)


def document_name(path: str) -> str:
    """A document's file name, for a sentence in backticks."""
    return inline_code(PurePosixPath(path).name)


__all__ = ["document_name", "fence_safe", "inline_code"]
