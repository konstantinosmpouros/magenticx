"""Internal (agents → bridge) shapes for a conversation: its uploads (plan 36)
and the message the user sent while a run works (steering, SSE plan phase 5)."""
from pydantic import BaseModel, ConfigDict, Field

from schema.base import UTCDateTime


class InputFileOut(BaseModel):
    """One upload as the agent's ``/conversation/input/<name>``."""
    name: str
    attachment_id: str
    mime: str
    size: int
    sha256: str
    created_at: str | None = None


class InputFilesOut(BaseModel):
    files: list[InputFileOut]


class InterjectionClaimIn(BaseModel):
    """The agent asks for the message waiting behind its run."""
    model_config = ConfigDict(extra="forbid")

    user_id: str = Field(min_length=1, max_length=128)
    #: The bridge's run id (the run's assistant message), from the run context.
    run_id: str = Field(min_length=1, max_length=128)


class InterjectionOut(BaseModel):
    """One claimed message: from now on it belongs to the run that read it."""
    content: str
    queued_at: UTCDateTime


class InterjectionsOut(BaseModel):
    """What a run claimed at one step: the leading queued messages, oldest first."""
    messages: list[InterjectionOut]
