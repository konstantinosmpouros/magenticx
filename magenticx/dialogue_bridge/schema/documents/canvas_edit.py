"""Ask agent on a canvas selection (plan 44, Phase 4.3): the passage a user message is about.

The canvas's selection menu ("Ask agent", and the presets Shorter / Longer /
Formal / Simpler / Polish) sends an ordinary user message whose ``content`` is
the instruction as the bubble shows it, plus ``canvasEdit``: which document,
the version the selection was made on, the selected text, the headings above
it, the instruction and the preset. It is a user-only field like ``command``
(plan 35): stored on the message row (``messages.canvas_edit``), returned on
reads, and carried to the agents service's run context, which turns it into a
scoped instruction for that turn only.

Plan 44 v2: the same message is sent when the user writes ``@agent`` in a
canvas comment. ``commentId`` then names the comment **thread** (always the
thread, even when the ``@agent`` text was a reply) — a canonical UUID, checked
with the agents service before anything commits (engine/documents/canvas_edit.py) and
carried to the run, where the agent answers and resolves that thread.

Everything in it is the user's text. The bounds here are the contract's and
are enforced server-side; the agents service validates the run context again
and only ever puts the text into the model as quoted data.
"""
import re
import uuid
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

#: The canvas presets; each maps to a fixed hint in the agents service.
CanvasEditPreset = Literal["shorter", "longer", "formal", "simpler", "polish"]

CANVAS_EDIT_PATH_MAX_CHARS = 1024
CANVAS_EDIT_SELECTION_MAX_CHARS = 8000
CANVAS_EDIT_INSTRUCTION_MAX_CHARS = 2000
CANVAS_EDIT_HEADINGS_MAX = 6
CANVAS_EDIT_HEADING_MAX_CHARS = 200

#: A cheap first cut of the documents routes' rule (a ``.md`` under
#: ``/conversation/output/``, no empty, ``.`` or ``..`` segment). The agents
#: service's canonical check is the authority (engine/documents/canvas_edit.py asks it).
_DOCUMENT_PATH = re.compile(r"^/conversation/output/(?:[^/]+/)*[^/]+\.md$")
_DOT_SEGMENT = re.compile(r"(^|/)\.{1,2}(/|$)")
_NUL = chr(0)


def _no_nul(value: str) -> str:
    """Refuse a NUL: never text a user selected or typed, and Postgres text cannot hold one."""
    if _NUL in value:
        raise ValueError("The text holds a NUL character.")
    return value


class _CanvasEdit(BaseModel):
    """The fields, in the camelCase of the rest of ``MessageIn``."""

    path: str = Field(min_length=1, max_length=CANVAS_EDIT_PATH_MAX_CHARS)
    version: int = Field(ge=1)
    selection: str = Field(min_length=1, max_length=CANVAS_EDIT_SELECTION_MAX_CHARS)
    headingPath: list[str] = Field(default_factory=list, max_length=CANVAS_EDIT_HEADINGS_MAX)
    instruction: str = Field(min_length=1, max_length=CANVAS_EDIT_INSTRUCTION_MAX_CHARS)
    preset: CanvasEditPreset | None = None
    #: The comment thread the request came from (plan 44 v2); null for Ask agent.
    commentId: str | None = Field(None, max_length=36)

    @field_validator("commentId")
    @classmethod
    def _thread_id(cls, value: str | None) -> str | None:
        # Canonical form only (lowercase, hyphenated): the agents service puts
        # the id into the model's instruction verbatim, and stores compare it.
        if value is not None:
            try:
                canonical = str(uuid.UUID(value))
            except ValueError as exc:
                raise ValueError("commentId is not a comment id.") from exc
            if canonical != value:
                raise ValueError("commentId is not a canonical comment id.")
        return value


class CanvasEditIn(_CanvasEdit):
    """``MessageIn.canvasEdit``: validated strictly — unknown keys are refused."""

    model_config = ConfigDict(extra="forbid")

    @field_validator("path")
    @classmethod
    def _document_path(cls, value: str) -> str:
        if not _DOCUMENT_PATH.match(value) or _DOT_SEGMENT.search(value) or _NUL in value:
            raise ValueError("A canvas edit names a .md document under /conversation/output/.")
        return value

    @field_validator("selection", "instruction")
    @classmethod
    def _text(cls, value: str) -> str:
        _no_nul(value)
        if not value.strip():
            raise ValueError("The text is empty.")
        return value

    @field_validator("headingPath")
    @classmethod
    def _headings(cls, value: list[str]) -> list[str]:
        for heading in value:
            _no_nul(heading)
            if not heading.strip() or len(heading) > CANVAS_EDIT_HEADING_MAX_CHARS:
                raise ValueError(f"Each heading is 1 to {CANVAS_EDIT_HEADING_MAX_CHARS} characters.")
        return value


class CanvasEditOut(_CanvasEdit):
    """``MessageOut.canvasEdit``: a stored value read back. Unknown keys are dropped;
    a value that does not fit is turned into null by the message's validator."""

    model_config = ConfigDict(extra="ignore")
