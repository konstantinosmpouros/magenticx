"""Run one fixed conversion in the sandbox box (plan 44, Phase 4.5).

The same runner and the same call as ``execute`` (``POST /v1/exec`` over mTLS
with the internal credential, see :mod:`harness.filesystem.sandbox_backend`),
but the platform's own: the command is a :class:`~.commands.ConversionJob`
constant, the files are the ones the job names and nothing else (never the
conversation's input/ or output/), and nothing is written back to the
conversation — the one output file comes back to the caller as bytes.

Failures are typed so the routes can map them, never retried and never
answered from anywhere else (fail closed, as ``execute``):

* :class:`ConversionUnavailable` — no runner (execution off or no URL), the
  runner unreachable, busy (429) or unhealthy (503 / 5xx). → 503.
* :class:`ConversionTimeout` — the box's wall clock killed it, or the runner
  did not answer in time. → 504.
* :class:`ConversionFailed` — it ran but produced no usable output (a non-zero
  exit, another kill, a refused request, an unreadable answer). → 502.

Logs carry the job's output name, sizes and the runner's status only — never
a byte of a document.
"""
from __future__ import annotations

import base64
import binascii
import re
from typing import Literal

import httpx
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from core.logging import get_logger
from core.security.internal_trust import internal_service_headers
from core.security.tls import get_httpx_client_cert, get_httpx_verify
from core.settings import settings
from harness.conversions.commands import ConversionJob

logger = get_logger(__name__)

EXEC_PATH = "/v1/exec"
#: The runner's input cap (SANDBOX_MAX_INPUT_BYTES, 20 MiB by default): a
#: bigger input is refused here, before a round trip.
MAX_INPUT_BYTES = 20 * 1024 * 1024
#: Slack between the box's wall clock and the HTTP read timeout, so the
#: runner's own kill (and its answer) lands before the client gives up.
_READ_TIMEOUT_MARGIN_SECONDS = 15.0
# The runner's id rule (schema/exec.py ID_PATTERN): one plain path segment.
_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")

#: The ``agent_slug`` the runner's audit record shows for a platform job —
#: never a real agent's, so a conversion is never mistaken for model code.
ConversionPurpose = Literal["platform-export", "platform-preview"]


class ConversionError(Exception):
    """Base of the three outcomes below."""


class ConversionUnavailable(ConversionError):
    """The box cannot run now (off, unreachable, busy or unhealthy)."""


class ConversionTimeout(ConversionError):
    """The conversion ran past its time limit."""


class ConversionFailed(ConversionError):
    """The conversion ran but gave no usable file."""


class _Returned(BaseModel):
    model_config = ConfigDict(extra="ignore")

    path: str
    content_b64: str


class _Result(BaseModel):
    model_config = ConfigDict(extra="ignore")

    exit_code: int | None = None
    killed_reason: str | None = None
    duration_ms: int = Field(0, ge=0)
    files: list[_Returned] = Field(default_factory=list)


def conversions_available() -> bool:
    """Whether this deployment may use the box at all: the ``execute`` kill
    switch AND a runner URL (``sandbox_execution_active``)."""
    return settings.filesystem.sandbox_execution_active


def _checked_id(value: str) -> str:
    if not isinstance(value, str) or not _ID_RE.match(value):
        # A malformed id would be a 422 from the runner; refuse it here so it
        # never leaves the service.
        raise ConversionFailed("invalid identity")
    return value


async def run_conversion(
    job: ConversionJob,
    files: dict[str, bytes],
    *,
    user_id: str,
    conversation_id: str,
    purpose: ConversionPurpose,
    transport: httpx.AsyncBaseTransport | None = None,
) -> bytes:
    """Run ``job`` over ``files`` (keyed by the job's input names) in a fresh
    box and return the bytes of its one output file.

    ``transport`` exists for tests (an ``httpx.MockTransport``).
    """
    if not conversions_available():
        raise ConversionUnavailable("sandbox execution is off or no runner is configured")
    if set(files) != set(job.inputs):
        # A wiring bug: the job and its files must match exactly.
        raise ValueError("The conversion's files do not match its job.")
    if sum(len(data) for data in files.values()) > MAX_INPUT_BYTES:
        raise ConversionFailed("input too large")

    timeout_seconds = settings.filesystem.sandbox_conversion_timeout_seconds
    payload = {
        "user_id": _checked_id(user_id),
        "agent_slug": purpose,
        "conversation_id": _checked_id(conversation_id),
        "command": job.command,
        "timeout_seconds": timeout_seconds,
        "workdir": "output",
        "files": [
            {"path": name, "content_b64": base64.b64encode(data).decode("ascii")}
            for name, data in files.items()
        ],
    }
    url = f"{settings.filesystem.sandbox_runner_url.rstrip('/')}{EXEC_PATH}"
    http_timeout = httpx.Timeout(
        timeout_seconds + _READ_TIMEOUT_MARGIN_SECONDS,
        connect=settings.filesystem.sandbox_runner_connect_timeout_seconds,
    )
    try:
        async with httpx.AsyncClient(
            timeout=http_timeout, verify=get_httpx_verify(), cert=get_httpx_client_cert(), transport=transport
        ) as client:
            response = await client.post(url, json=payload, headers=internal_service_headers(user_id=user_id))
    except httpx.TimeoutException as exc:
        _log("conversion_runner_timeout", "The sandbox runner did not answer a conversion in time", job, purpose)
        raise ConversionTimeout("runner timeout") from exc
    except httpx.HTTPError as exc:
        _log("conversion_runner_unreachable", "The sandbox runner could not be reached for a conversion",
             job, purpose, failure_reason=type(exc).__name__)
        raise ConversionUnavailable("runner unreachable") from exc

    status = response.status_code
    if status != 200:
        _log("conversion_runner_refused", "The sandbox runner refused or failed a conversion",
             job, purpose, status_code=status)
        if status == 429 or status >= 500:
            raise ConversionUnavailable(f"runner status {status}")
        raise ConversionFailed(f"runner status {status}")
    try:
        result = _Result.model_validate(response.json())
    except (ValueError, ValidationError) as exc:
        _log("conversion_runner_unreadable", "The sandbox runner answered a conversion unreadably", job, purpose)
        raise ConversionFailed("unreadable answer") from exc

    if result.killed_reason == "timeout":
        _log("conversion_timed_out", "A conversion ran past its time limit", job, purpose,
             duration_ms=result.duration_ms)
        raise ConversionTimeout("box timeout")
    if result.killed_reason is not None or result.exit_code != 0:
        _log("conversion_failed", "A conversion exited without a result", job, purpose,
             exit_code=result.exit_code, killed_reason=result.killed_reason, duration_ms=result.duration_ms)
        raise ConversionFailed("non-zero exit")
    # Only the job's own output is accepted; anything else the box wrote is
    # ignored (it cannot be the answer, whatever its name).
    output = next((f for f in result.files if f.path == job.output), None)
    if output is None:
        _log("conversion_no_output", "A conversion produced no output file", job, purpose,
             duration_ms=result.duration_ms)
        raise ConversionFailed("no output")
    try:
        data = base64.b64decode(output.content_b64, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ConversionFailed("undecodable output") from exc
    if not data:
        raise ConversionFailed("empty output")
    logger.info("conversion_completed", "A conversion ran in the sandbox", output=job.output, purpose=purpose,
                output_bytes=len(data), duration_ms=result.duration_ms)
    return data


def _log(event: str, message: str, job: ConversionJob, purpose: str, **fields: object) -> None:
    logger.warning(event, message, output=job.output, purpose=purpose, **fields)


__all__ = [
    "MAX_INPUT_BYTES",
    "ConversionError",
    "ConversionFailed",
    "ConversionPurpose",
    "ConversionTimeout",
    "ConversionUnavailable",
    "conversions_available",
    "run_conversion",
]
