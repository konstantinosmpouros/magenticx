"""The platform's fixed conversions in the sandbox box (plan 44, Phase 4.5).

A canvas document → ``.docx`` / ``.pdf`` (export) and an Office file → ``.pdf``
(attachment preview). Not ``execute``: the command is a constant of
:mod:`.commands`, never the model's, so no approval is asked; the box and its
controls are the same. :mod:`.client` runs a job through the runner.
"""
from harness.conversions.client import (
    MAX_INPUT_BYTES,
    ConversionError,
    ConversionFailed,
    ConversionTimeout,
    ConversionUnavailable,
    conversions_available,
    run_conversion,
)
from harness.conversions.commands import (
    DOCX_MEDIA_TYPE,
    EXPORT_FORMATS,
    MARKDOWN_INPUT,
    OFFICE_PREVIEW_EXTENSIONS,
    PDF_MEDIA_TYPE,
    REFERENCE_DOCX_PATH,
    REFERENCE_INPUT,
    ConversionJob,
    ExportFormat,
    OfficeExtension,
    export_job,
    office_preview_job,
)

__all__ = [
    "DOCX_MEDIA_TYPE",
    "EXPORT_FORMATS",
    "MARKDOWN_INPUT",
    "MAX_INPUT_BYTES",
    "OFFICE_PREVIEW_EXTENSIONS",
    "PDF_MEDIA_TYPE",
    "REFERENCE_DOCX_PATH",
    "REFERENCE_INPUT",
    "ConversionError",
    "ConversionFailed",
    "ConversionJob",
    "ConversionTimeout",
    "ConversionUnavailable",
    "ExportFormat",
    "OfficeExtension",
    "conversions_available",
    "export_job",
    "office_preview_job",
    "run_conversion",
]
