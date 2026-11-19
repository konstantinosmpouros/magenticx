"""Export a canvas document (plan 44, Phase 4.5): the request the browser sends.

The answer is the file itself (``Content-Disposition: attachment``), so there
is no response model; the error bodies are built in ``utils/document_export.py``.
"""
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from schema.documents import DOCUMENT_PATH_MAX_CHARS

DocumentExportFormat = Literal["docx", "pdf", "md"]


class DocumentExportIn(BaseModel):
    """Which document, which version (omitted = the latest), which format."""

    model_config = ConfigDict(extra="forbid")

    path: str = Field(min_length=1, max_length=DOCUMENT_PATH_MAX_CHARS)
    version: int | None = Field(None, ge=1)
    format: DocumentExportFormat
