"""The fixed conversion commands the platform runs in the sandbox box (plan 44, Phase 4.5).

Two jobs, and only these two: a canvas document's markdown → ``.docx`` (pandoc
with the reference document next to this module) → ``.pdf`` (LibreOffice
headless), and an Office file → ``.pdf`` (LibreOffice headless) for the
attachment preview.

Why this module exists on its own: a conversion is **not** ``execute``. The
model never writes or chooses the command and no one approves it, so the one
thing that keeps it safe is that the command is a constant. Every argv here is
built from string literals and a value picked from a closed set
(:data:`EXPORT_FORMATS`, :data:`OFFICE_PREVIEW_EXTENSIONS`); the user's text
reaches the box only as the *content* of a file under ``input/`` whose name is
fixed too (``document.md``, ``source.<ext>``). The tests pin that no user
string can appear in a command.

The box itself is unchanged: the same runner call as ``execute``
(``POST /v1/exec``), the same gVisor box with no network, a read-only root, a
non-root uid, the runner's limits. ``pandoc``'s own ``--sandbox`` flag is not
used: pandoc 2.17 (the box's) cannot load its docx template under it, and the
box already holds nothing but the input files, so a markdown image that names
a box path can embed nothing of value.
"""
from __future__ import annotations

import shlex
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

#: What a canvas document exports to through the box (``md`` never reaches it).
ExportFormat = Literal["docx", "pdf"]
EXPORT_FORMATS: frozenset[str] = frozenset({"docx", "pdf"})

#: Office files the attachment preview renders: the OOXML trio and their
#: OpenDocument twins. Legacy binary formats (.doc/.xls/.ppt) and macro
#: workbooks are left to the existing preview.
OfficeExtension = Literal["docx", "xlsx", "pptx", "odt", "ods", "odp"]
OFFICE_PREVIEW_EXTENSIONS: frozenset[str] = frozenset({"docx", "xlsx", "pptx", "odt", "ods", "odp"})

#: The reference document pandoc styles the .docx from: Calibri for body and
#: headings (LibreOffice maps it to Carlito, which covers Greek; Word has it),
#: Courier New for code (Liberation Mono in the box), bordered tables with a
#: shaded header row. Built from pandoc 2.17's own default; it travels with
#: every export as ``input/reference.docx``, so the box image needs no change.
REFERENCE_DOCX_PATH = Path(__file__).with_name("reference.docx")

#: The fixed names inside the call's temp dir (the runner's ``input/`` and
#: ``output/``). Never derived from the document's or the upload's name.
MARKDOWN_INPUT = "input/document.md"
REFERENCE_INPUT = "input/reference.docx"
_BOX_ROOT = "/conversation"

# pandoc's reader: GitHub-flavoured markdown, what the canvas editor writes.
_PANDOC_FROM = "gfm"


@dataclass(frozen=True)
class ConversionJob:
    """One fixed command and the single output file it must produce.

    ``inputs`` names the files the caller must send (``input/…``), so a job
    and its files cannot drift apart; ``output`` is the one ``output/…`` file
    taken back; ``media_type`` is what the bytes are.
    """

    command: str
    inputs: tuple[str, ...]
    output: str
    media_type: str


DOCX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
PDF_MEDIA_TYPE = "application/pdf"


def _box(path: str) -> str:
    """A call-dir name (``input/x``) as the box sees it (``/conversation/input/x``)."""
    return f"{_BOX_ROOT}/{path}"


def _line(*argv: str) -> str:
    """One shell line from literal argv parts. ``shlex.quote`` is belt and
    braces: every part is a constant of this module already."""
    return " ".join(shlex.quote(part) for part in argv)


def _soffice_to_pdf(source: str, outdir: str) -> str:
    # --norestore: no crash-recovery prompt from a previous profile; output
    # silenced because LibreOffice's chatter is not useful to anyone.
    return _line("soffice", "--headless", "--norestore", "--convert-to", "pdf", "--outdir", outdir, source) + (
        " >/dev/null"
    )


def export_job(fmt: ExportFormat) -> ConversionJob:
    """The fixed markdown → docx (→ pdf) command for one export format."""
    if fmt not in EXPORT_FORMATS:
        raise ValueError("Unsupported export format.")
    pandoc = ["pandoc", f"--from={_PANDOC_FROM}", "--to=docx", f"--reference-doc={_box(REFERENCE_INPUT)}"]
    if fmt == "docx":
        lines = [_line(*pandoc, f"--output={_box('output/document.docx')}", _box(MARKDOWN_INPUT))]
        return ConversionJob(
            command="set -eu\n" + "\n".join(lines),
            inputs=(MARKDOWN_INPUT, REFERENCE_INPUT),
            output="output/document.docx",
            media_type=DOCX_MEDIA_TYPE,
        )
    # PDF: the intermediate .docx goes to /tmp (the box's tmpfs), so the only
    # new file under output/ — the only one the runner sends back — is the PDF.
    lines = [
        _line(*pandoc, "--output=/tmp/document.docx", _box(MARKDOWN_INPUT)),
        _soffice_to_pdf("/tmp/document.docx", _box("output")),
    ]
    return ConversionJob(
        command="set -eu\n" + "\n".join(lines),
        inputs=(MARKDOWN_INPUT, REFERENCE_INPUT),
        output="output/document.pdf",
        media_type=PDF_MEDIA_TYPE,
    )


def office_preview_job(extension: OfficeExtension) -> ConversionJob:
    """The fixed Office → PDF command for one allowed extension."""
    if extension not in OFFICE_PREVIEW_EXTENSIONS:
        raise ValueError("Unsupported Office file type.")
    source = f"input/source.{extension}"
    return ConversionJob(
        command="set -eu\n" + _soffice_to_pdf(_box(source), _box("output")),
        inputs=(source,),
        output="output/source.pdf",
        media_type=PDF_MEDIA_TYPE,
    )


__all__ = [
    "DOCX_MEDIA_TYPE",
    "EXPORT_FORMATS",
    "MARKDOWN_INPUT",
    "OFFICE_PREVIEW_EXTENSIONS",
    "PDF_MEDIA_TYPE",
    "REFERENCE_DOCX_PATH",
    "REFERENCE_INPUT",
    "ConversionJob",
    "ExportFormat",
    "OfficeExtension",
    "export_job",
    "office_preview_job",
]
