"""Bridge ↔ agents: export a canvas document (plan 44, Phase 4.5).

The response is the file itself (bytes, not JSON); its name travels in the
``X-Export-Filename`` header, percent-encoded UTF-8, for the bridge to put in
the browser's ``Content-Disposition``. The Office preview takes the raw file
as the request body and answers the PDF, so it has no JSON model.
"""
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

#: Same bound as the document routes' paths.
_PATH_MAX = 1024


class ExportDocumentRequest(BaseModel):
    """Which version of which document, as which format (``version`` omitted = the latest)."""

    model_config = ConfigDict(extra="forbid")

    path: str = Field(min_length=1, max_length=_PATH_MAX)
    version: int | None = Field(None, ge=1)
    format: Literal["docx", "pdf", "md"]
