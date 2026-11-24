"""Steering: a message the user sends while a run works reaches that run.

Without this, a message sent to a busy conversation waits in the composer's
queue (the bridge's ``conversations.queued_message``) until the run ends and
is then sent as a new turn. With it, the run reads the message at its next
**step boundary** — just before its next model call, when every tool result
of the step is in — and the model answers with it in view.

How the message gets here (SSE plan, phase 5):

* **The bridge keeps it.** The queued slot stays the only record. When a
  message is queued behind this run, the bridge also sets a Redis flag,
  ``run:{run_id}:steer`` — a doorbell, never the record.
* **Before each model call** this middleware checks the flag (one ``EXISTS``).
  Only when it is set does it ask the bridge to hand the message over
  (``POST /v1/internal/conversations/{id}/interjection/claim``). The claim
  empties the slot under a row lock, the same lock the run-end send takes, so
  the message is read by this run *or* sent after it — never both, never
  twice.
* **It becomes a ``HumanMessage``** in the agent's state, marked
  ``lc_source = "user_interjection"``. It lands in the checkpoint like any
  message, so later turns see it too, and the normalizer turns it into a
  ``USER_INTERJECTION`` event for the timeline.

Everything here fails open: Redis down, the bridge slow or refusing — the step
goes ahead without the message, and the bridge sends it when the run ends, as
before. Only the main agent of an interactive run gets this middleware; a
background task never reads the user's composer.
"""
from __future__ import annotations

from typing import Any

import httpx
import redis.asyncio as aioredis
from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import HumanMessage
from redis.exceptions import RedisError

from core.logging import get_logger
from core.security.internal_trust import internal_service_headers
from core.security.tls import get_httpx_client_cert, get_httpx_verify
from core.settings import settings
from harness.async_tasks.events import create_redis_client

logger = get_logger(__name__)

#: ``additional_kwargs["lc_source"]`` of an interjected message — how the
#: normalizer tells it from the run's own input.
INTERJECTION_SOURCE = "user_interjection"
#: ``additional_kwargs`` key holding what the timeline event needs.
INTERJECTION_DATA_KEY = "lc_data"

#: One process-wide client, opened on the first check (a run that never gets a
#: doorbell never connects).
_REDIS: aioredis.Redis | None = None


def steer_key(run_id: str) -> str:
    """The doorbell the bridge sets while a message waits behind ``run_id``.

    The bridge's ``engine.inference.steering`` writes the same key.
    """
    return f"run:{run_id}:steer"


def _shared_redis() -> aioredis.Redis:
    global _REDIS
    if _REDIS is None:
        _REDIS = create_redis_client()
    return _REDIS


class SteeringMiddleware(AgentMiddleware):
    """Reads the user's queued message into the run before each model call."""

    def __init__(
        self,
        *,
        user_id: str,
        conversation_id: str,
        run_id: str,
        redis_client: aioredis.Redis | None = None,
    ) -> None:
        super().__init__()
        self._user_id = user_id
        self._conversation_id = conversation_id
        self._run_id = run_id
        self._redis = redis_client

    async def abefore_model(self, state: Any, runtime: Any) -> dict[str, Any] | None:
        """The step boundary: add the waiting messages to the state, oldest first."""
        if not await self._doorbell_rung():
            return None
        claimed = await self._claim()
        messages = [
            HumanMessage(
                content=item["content"],
                additional_kwargs={
                    "lc_source": INTERJECTION_SOURCE,
                    INTERJECTION_DATA_KEY: {
                        "queued_at": item.get("queued_at") if isinstance(item.get("queued_at"), str) else None
                    },
                },
            )
            for item in claimed
            if isinstance(item.get("content"), str) and item["content"].strip()
        ]
        if not messages:
            return None
        logger.info(
            "steering_message_read",
            "The run read messages the user sent while it worked",
            run_id=self._run_id,
            conversation_id=self._conversation_id,
            messages=len(messages),
        )
        return {"messages": messages}

    async def _doorbell_rung(self) -> bool:
        """One ``EXISTS``. A Redis failure reads as "nothing waiting"."""
        try:
            client = self._redis or _shared_redis()
            return bool(await client.exists(steer_key(self._run_id)))
        except (RedisError, OSError) as exc:
            logger.warning(
                "steering_doorbell_failed",
                "Could not check for a message sent during the run",
                run_id=self._run_id,
                error_type=type(exc).__name__,
            )
            return False

    async def _claim(self) -> list[dict[str, Any]]:
        """Ask the bridge for the waiting messages, oldest first. ``[]`` when there
        are none to read now or the call failed."""
        url = (
            f"{settings.bridge.conversations_url}/{self._conversation_id}/interjection/claim"
        )
        timeout = httpx.Timeout(settings.steering.claim_timeout_seconds)
        try:
            async with httpx.AsyncClient(
                timeout=timeout, verify=get_httpx_verify(), cert=get_httpx_client_cert()
            ) as client:
                response = await client.post(
                    url,
                    json={"user_id": self._user_id, "run_id": self._run_id},
                    headers=internal_service_headers(),
                )
            if response.status_code == httpx.codes.NO_CONTENT:
                return []
            response.raise_for_status()
            body = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            logger.warning(
                "steering_claim_failed",
                "Could not claim the message sent during the run; it is sent when the run ends",
                run_id=self._run_id,
                error_type=type(exc).__name__,
            )
            return []
        items = body.get("messages") if isinstance(body, dict) else None
        return [item for item in items if isinstance(item, dict)] if isinstance(items, list) else []


def steering_available(context: dict[str, Any] | None, *, interactive: bool) -> bool:
    """Whether this run reads messages sent while it works.

    Needs the run's user, conversation and bridge run id (from the request
    context the bridge sends), an interactive run — someone is there to type —
    and the ``STEERING_ENABLED`` switch. The prompt section is gated on the
    same answer, so it never describes messages the run cannot receive.
    """
    ctx = context or {}
    return bool(
        settings.steering.enabled
        and interactive
        and ctx.get("user_id")
        and ctx.get("conversation_id")
        and ctx.get("run_id")
    )


def build_steering_middleware(context: dict[str, Any] | None, *, interactive: bool) -> SteeringMiddleware | None:
    """The middleware for this run, or None when it does not steer (:func:`steering_available`)."""
    if not steering_available(context, interactive=interactive):
        return None
    ctx = context or {}
    return SteeringMiddleware(
        user_id=str(ctx["user_id"]), conversation_id=str(ctx["conversation_id"]), run_id=str(ctx["run_id"])
    )


__all__ = [
    "INTERJECTION_DATA_KEY",
    "INTERJECTION_SOURCE",
    "SteeringMiddleware",
    "build_steering_middleware",
    "steer_key",
    "steering_available",
]
