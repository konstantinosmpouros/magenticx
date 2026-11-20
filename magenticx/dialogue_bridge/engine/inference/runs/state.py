"""Run states shared by every part of the run engine, and the clock it stamps rows with."""

from datetime import datetime, timezone
from core.logging import get_logger

logger = get_logger(__name__)


ACTIVE_RUN_STATUSES = {"queued", "running", "cancelling"}


TERMINAL_RUN_STATUSES = {"completed", "cancelled", "failed"}


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)
