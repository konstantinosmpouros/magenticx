"""Export a canvas document, and render an Office file as a PDF (plan 44, Phase 4.5).

What the bridge asks for when the user clicks Export (Word / PDF / Markdown)
or opens an Office attachment:

* **Export.** The stored version (the latest, or the one asked for) is the only
  input. ``md`` is that text as it is, no box. ``docx`` / ``pdf`` run the fixed
  pandoc (→ LibreOffice) job of :mod:`harness.conversions` in the sandbox box.
  The download's name is the document's first H1, else its file name, cut down
  to safe characters (:func:`export_filename`).
* **Office preview.** The bridge sends an attachment's bytes it has already
  owner-checked; this renders them with the fixed LibreOffice job. Stateless:
  the bridge caches the PDF beside the attachment, so the cache lives and dies
  with it.

Logs carry formats, sizes and versions, never a path, a title or a byte of
content — all three can hold the user's words.
"""
from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from functools import cache
from pathlib import PurePosixPath
from typing import Literal

from core.logging import get_logger
from harness.conversation_files import DocumentVersionStore
from harness.conversation_files.versions import DocumentVersion, document_path
from harness.conversions import (
    MARKDOWN_INPUT,
    REFERENCE_DOCX_PATH,
    REFERENCE_INPUT,
    OfficeExtension,
    export_job,
    office_preview_job,
    run_conversion,
)
from harness.memory import get_memory_pool

logger = get_logger(__name__)

ExportFormatName = Literal["docx", "pdf", "md"]

MEDIA_TYPES: dict[str, str] = {
    "md": "text/markdown; charset=utf-8",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "pdf": "application/pdf",
}

#: Longest title kept in a file name (characters, before the extension).
MAX_TITLE_CHARS = 80
_FALLBACK_TITLE = "document"

_FENCE_RE = re.compile(r"^ {0,3}(```|~~~)")
_ATX_H1_RE = re.compile(r"^ {0,3}#[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$")
_SETEXT_H1_RE = re.compile(r"^ {0,3}=+[ \t]*$")
_IMAGE_RE = re.compile(r"!\[([^\]]*)\]\([^)]*\)")
_LINK_RE = re.compile(r"\[([^\]]*)\]\([^)]*\)")
_INLINE_MARKS_RE = re.compile(r"[*`~]")
# Punctuation a file name may keep; everything else that is not a letter, a
# digit or a space becomes a space (slashes, quotes, colons, controls, …).
_KEEP_PUNCTUATION = frozenset("-_.,()&+")


@dataclass(frozen=True)
class ExportedFile:
    """The bytes of an export with what the response needs to name them."""

    content: bytes
    media_type: str
    filename: str
    version: int


def _store() -> DocumentVersionStore:
    return DocumentVersionStore(get_memory_pool())


@cache
def _reference_docx() -> bytes:
    """The pandoc reference document, read once per process (10 KB)."""
    return REFERENCE_DOCX_PATH.read_bytes()


def first_heading(markdown: str) -> str | None:
    """The text of the document's first level-1 heading (ATX ``# Title`` or
    setext ``Title`` / ``===``), outside code fences; None when there is none."""
    in_fence: str | None = None
    previous = ""
    for line in markdown.splitlines():
        fence = _FENCE_RE.match(line)
        if fence:
            marker = fence.group(1)
            in_fence = None if in_fence == marker else (in_fence or marker)
            previous = ""
            continue
        if in_fence:
            continue
        atx = _ATX_H1_RE.match(line)
        if atx:
            return atx.group(1)
        if _SETEXT_H1_RE.match(line) and previous.strip():
            return previous.strip()
        previous = line
    return None


def safe_title(text: str | None) -> str:
    """``text`` as the stem of a download's file name: markdown marks removed,
    only letters (any script — Greek stays Greek), digits, spaces and a little
    punctuation kept, whitespace collapsed, at most :data:`MAX_TITLE_CHARS`.
    Empty when nothing usable is left."""
    if not text:
        return ""
    value = unicodedata.normalize("NFC", text)
    value = _IMAGE_RE.sub(r"\1", value)
    value = _LINK_RE.sub(r"\1", value)
    value = _INLINE_MARKS_RE.sub("", value)
    kept = []
    for ch in value:
        category = unicodedata.category(ch)
        if category[0] in ("L", "N") or ch in _KEEP_PUNCTUATION:
            kept.append(ch)
        else:
            kept.append(" ")
    value = " ".join("".join(kept).split())
    value = value[:MAX_TITLE_CHARS].strip()
    # No leading dot (a hidden file) and no trailing dot or space (Windows
    # drops them, and "title..docx" reads badly).
    return value.strip(". ")


def export_filename(markdown: str, document_name: str, fmt: str) -> str:
    """``<title>.<fmt>``: the first H1, else the file name without ``.md``,
    else ``document``."""
    title = safe_title(first_heading(markdown)) or safe_title(PurePosixPath(document_name).stem)
    return f"{title or _FALLBACK_TITLE}.{fmt}"


async def _version(user_id: str, conversation_id: str, path: str, version: int | None) -> DocumentVersion:
    canonical = document_path(path)  # 422 before any query
    store = _store()
    if version is None:
        return await store.latest(user_id, conversation_id, canonical)
    return await store.get_version(user_id, conversation_id, canonical, version)


async def export_document(
    user_id: str, conversation_id: str, path: str, version: int | None, fmt: ExportFormatName
) -> ExportedFile:
    """One version of a canvas document as ``fmt``.

    Raises the store's ``InvalidDocumentPath`` / ``DocumentNotFound`` and, for
    docx/pdf, :mod:`harness.conversions`' ``ConversionUnavailable`` /
    ``ConversionTimeout`` / ``ConversionFailed`` — the route maps them.
    """
    found = await _version(user_id, conversation_id, path, version)
    text = found.content or ""
    filename = export_filename(text, found.name, fmt)
    if fmt == "md":
        content = text.encode("utf-8")
    else:
        content = await run_conversion(
            export_job(fmt),
            {MARKDOWN_INPUT: text.encode("utf-8"), REFERENCE_INPUT: _reference_docx()},
            user_id=user_id,
            conversation_id=conversation_id,
            purpose="platform-export",
        )
    logger.info("document_exported", "Exported a canvas document", format=fmt, version=found.version,
                output_bytes=len(content))
    return ExportedFile(content=content, media_type=MEDIA_TYPES[fmt], filename=filename, version=found.version)


async def render_office_preview(
    user_id: str, conversation_id: str, extension: OfficeExtension, data: bytes
) -> bytes:
    """An Office file's bytes as a PDF, rendered in the box by LibreOffice."""
    job = office_preview_job(extension)
    [source] = job.inputs
    pdf = await run_conversion(job, {source: data}, user_id=user_id, conversation_id=conversation_id,
                               purpose="platform-preview")
    logger.info("office_preview_rendered", "Rendered an Office file as a PDF", extension=extension,
                input_bytes=len(data), output_bytes=len(pdf))
    return pdf


__all__ = [
    "MAX_TITLE_CHARS",
    "MEDIA_TYPES",
    "ExportFormatName",
    "ExportedFile",
    "export_document",
    "export_filename",
    "first_heading",
    "render_office_preview",
    "safe_title",
]
