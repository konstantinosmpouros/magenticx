"""One agent's tools and model for one user: the manifest from the agents
service merged with the user's choices, and the writes that change them.
"""

from typing import Any, Dict
import httpx
from fastapi import HTTPException, status
from pydantic import ValidationError
from core.logging import get_context, get_logger
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from core.settings import settings
from engine.agents import tool_prefs as agent_tool_prefs
from core.security.tls import get_httpx_client_cert, get_httpx_verify
from core.database import UserPreferencesTable
from core.security.internal_trust import internal_service_headers
from core.error_handling import upstream_error_handler
from schema import AgentModelResponse
from engine.agents.service_urls import AGENTS_SERVICE_URL
from engine.agents.catalog import get_usable_agent

logger = get_logger(__name__)

async def _memory_prefs(db: AsyncSession, user_id: str) -> Dict[str, str]:
    """The two preference flags that decide whether the memory builtins exist.

    The agents service cannot see them — they live here — so they are passed on
    the catalog request rather than guessed at on the far side.
    """
    row = (
        await db.execute(
            select(UserPreferencesTable).where(UserPreferencesTable.user_id == user_id)
        )
    ).scalar_one_or_none()
    return {
        "use_memory": str(bool(row.use_memory) if row else True).lower(),
        "search_past_convs": str(bool(row.search_past_convs) if row else False).lower(),
    }


def _agent_tools_url(user_id: str, agent_slug: str) -> str:
    base = AGENTS_SERVICE_URL.rstrip("/")
    return f"{base}/agents/{user_id}/{agent_slug}/tools"


async def _resolve_agent_slug(db: AsyncSession, user_id: str, agent_id: str) -> str:
    """Translate the catalog agent id (what the UI holds) into the slug the
    agents-service registry is keyed by, for an agent this user may use."""
    agent = await get_usable_agent(db, user_id, agent_id)
    slug = getattr(agent, "slug", None)
    if not slug:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Agent configuration is incomplete (missing slug).",
        )
    return slug


async def fetch_agent_tools(
    db: AsyncSession, user_id: str, agent_id: str
) -> Dict[str, Any]:
    """The tools this agent can use, with the user's overrides applied.

    Split ownership, deliberately: the agents service still answers *which tools
    exist* — the manifest, the MCP catalogue, whether the agent declared each one
    — because only it can see them. The user's on/off choices come from
    ``chat_db`` and are overlaid here, so a slow agents service can no longer
    make a user's settings look reset.

    ``agent_id`` is the catalog id from the UI, resolved here to the slug the
    agents registry and the override rows both key on.
    """
    slug = await _resolve_agent_slug(db, user_id, agent_id)
    payload = await _fetch_tool_manifest(db, user_id, slug)
    disabled, enabled, approvals = await agent_tool_prefs.read_prefs(db, user_id, slug)
    payload["tools"] = agent_tool_prefs.apply_to_rows(
        payload.get("tools") or [], disabled, enabled, approvals
    )
    return payload


async def _fetch_tool_manifest(db: AsyncSession, user_id: str, slug: str) -> dict[str, Any]:
    """The agents service's tool rows for this (user, agent), before any of the
    user's choices are applied, so each row's ``approval`` is the baseline."""
    timeout = settings.http.agents_timeout
    upstream_headers = internal_service_headers(get_context().get("request_id"))
    url = _agent_tools_url(user_id, slug)
    prefs = await _memory_prefs(db, user_id)
    try:
        async with httpx.AsyncClient(timeout=timeout, verify=get_httpx_verify(), cert=get_httpx_client_cert()) as client:
            resp = await upstream_error_handler.run_with_retries(
                logger,
                lambda: client.get(url, headers=upstream_headers, params=prefs),
                upstream_service="agents",
                operation="agent_tools_fetch",
            )
            resp.raise_for_status()
    except httpx.HTTPStatusError as exc:
        upstream_error_handler.raise_http_error(
            logger, exc, event="agent_tools_fetch_failed",
            message="Agents service returned an HTTP error while fetching agent tools",
            public_detail="Agent tools could not be loaded. Please try again.",
            upstream_service="agents", operation="agent_tools_fetch",
        )
    except httpx.RequestError as exc:
        upstream_error_handler.raise_request_error(
            logger, exc, event="agent_tools_unreachable",
            message="Failed to reach agents service while fetching agent tools",
            public_detail="Agent tools are temporarily unavailable. Please try again shortly.",
            upstream_service="agents", operation="agent_tools_fetch",
        )
    try:
        payload = resp.json()
    except ValueError as exc:
        upstream_error_handler.raise_invalid_response(
            logger, exc, event="agent_tools_invalid_json",
            message="Agents service returned invalid JSON for agent tools",
            public_detail="Agent tools returned an unexpected response.",
            upstream_service="agents", operation="agent_tools_fetch",
        )
    return payload


def _agent_model_url(user_id: str, agent_slug: str) -> str:
    """GET endpoint naming an agent's model and the reasoning efforts it accepts."""
    base = AGENTS_SERVICE_URL.rstrip("/")
    return f"{base}/agents/{user_id}/{agent_slug}/model"


async def fetch_agent_model(db: AsyncSession, user_id: str, agent_id: str) -> AgentModelResponse:
    """The agent's model and its reasoning efforts, for the composer's picker.

    Only the agents service knows which model an agent runs and which effort
    levels that model accepts, so this asks it, the same way the tool manifest
    is fetched: the catalog id is resolved to a slug for an agent this user may
    use (someone else's agent is a 404 before any upstream call), and the call
    carries the internal-service headers. The agents endpoint resolves the slug
    as a platform agent first, then as this user's own. The caller validates
    the body against ``schema.AgentModelResponse``.
    """
    slug = await _resolve_agent_slug(db, user_id, agent_id)
    timeout = settings.http.agents_timeout
    upstream_headers = internal_service_headers(get_context().get("request_id"))
    url = _agent_model_url(user_id, slug)
    try:
        async with httpx.AsyncClient(timeout=timeout, verify=get_httpx_verify(), cert=get_httpx_client_cert()) as client:
            resp = await upstream_error_handler.run_with_retries(
                logger,
                lambda: client.get(url, headers=upstream_headers),
                upstream_service="agents",
                operation="agent_model_fetch",
            )
            resp.raise_for_status()
    except httpx.HTTPStatusError as exc:
        upstream_error_handler.raise_http_error(
            logger, exc, event="agent_model_fetch_failed",
            message="Agents service returned an HTTP error while fetching the agent's model",
            public_detail="The agent's model could not be loaded. Please try again.",
            upstream_service="agents", operation="agent_model_fetch",
        )
    except httpx.RequestError as exc:
        upstream_error_handler.raise_request_error(
            logger, exc, event="agent_model_unreachable",
            message="Failed to reach agents service while fetching the agent's model",
            public_detail="The agent's model is temporarily unavailable. Please try again shortly.",
            upstream_service="agents", operation="agent_model_fetch",
        )
    try:
        payload = resp.json()
    except ValueError as exc:
        upstream_error_handler.raise_invalid_response(
            logger, exc, event="agent_model_invalid_json",
            message="Agents service returned invalid JSON for the agent's model",
            public_detail="The agent's model returned an unexpected response.",
            upstream_service="agents", operation="agent_model_fetch",
        )
    try:
        # Validated here, not in the router, so an upstream that answers with an
        # unknown level (or a non-object) is a 502 from the agents service, not
        # a 500 from the bridge, and never reaches the browser.
        return AgentModelResponse.model_validate(payload)
    except ValidationError as exc:
        upstream_error_handler.raise_invalid_response(
            logger, exc, event="agent_model_invalid_payload",
            message="Agents service returned an unexpected payload for the agent's model",
            public_detail="The agent's model returned an unexpected response.",
            upstream_service="agents", operation="agent_model_fetch",
        )


async def _write_and_refresh(db: AsyncSession, user_id: str, agent_id: str, tool_key: str, write):
    """Locate the row, let ``write`` record the choice, return refreshed rows.

    Both setters share this because the sequence — resolve the slug, read the
    manifest to learn what the tool *is*, write, re-overlay — is the same, and
    only the decision in the middle differs.
    """
    slug = await _resolve_agent_slug(db, user_id, agent_id)
    current = await fetch_agent_tools(db, user_id, agent_id)
    row = next(
        (r for r in (current.get("tools") or []) if str(r.get("key")) == tool_key),
        None,
    )
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="That tool is not available for this agent.",
        )

    await write(slug, row)
    await db.commit()

    disabled, enabled, approvals = await agent_tool_prefs.read_prefs(db, user_id, slug)
    current["tools"] = agent_tool_prefs.apply_to_rows(
        current.get("tools") or [], disabled, enabled, approvals
    )
    return current


async def set_agent_tool_enabled(
    db: AsyncSession, user_id: str, agent_id: str, tool_key: str, enabled: bool
) -> Dict[str, Any]:
    """Switch one MCP tool on or off for this (user, agent).

    Refused for a prebuilt tool: the framework builds those downstream of the
    tool list we hand it, so no stored preference could ever filter one, and
    accepting the request would show a switch that does nothing.
    """

    async def write(slug: str, row: Dict[str, Any]) -> None:
        if row.get("kind") == "builtin":
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Built-in tools are always available and cannot be switched off.",
            )
        await agent_tool_prefs.set_enabled(
            db, user_id, slug, tool_key,
            enabled=enabled, declared=bool(row.get("declared", True)),
        )

    return await _write_and_refresh(db, user_id, agent_id, tool_key, write)


async def set_agent_tool_approval(
    db: AsyncSession, user_id: str, agent_id: str, tool_key: str, approval: bool
) -> Dict[str, Any]:
    """Gate or ungate one tool for this (user, agent).

    A locked row is refused rather than stored: the runtime re-applies a locked
    gate after every user choice (and strips any gate from a tool that is itself
    a pause), so accepting would leave the UI showing a switch the runtime
    ignores.
    """

    async def write(slug: str, row: Dict[str, Any]) -> None:
        if row.get("approvalLocked"):
            raise _locked_gate_conflict(row)
        await agent_tool_prefs.set_approval(
            db, user_id, slug, tool_key,
            required=approval, baseline=bool(row.get("approval")),
        )

    return await _write_and_refresh(db, user_id, agent_id, tool_key, write)


def _locked_gate_conflict(row: dict[str, Any]) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail=(
            "That tool always requires approval and cannot be changed."
            if row.get("approval")
            else "That tool never pauses for approval and cannot be changed."
        ),
    )


async def set_agent_tool_approvals(
    db: AsyncSession, user_id: str, agent_id: str, approvals: dict[str, bool | None]
) -> dict[str, Any]:
    """Apply every approval choice for one agent in a single transaction.

    The builder's save step 2: the agent was just created or updated, and the
    choices made while building land as the user's preferences, in the same
    rows the agent's Approvals tab edits one at a time.

    All or nothing. Every key is checked against the agent's tool rows before
    anything is written: an unknown key is a 404 and a change to a locked gate
    a 409, as on the single-row route. A locked row sent with its own value (or
    ``None``) is skipped rather than refused, so a client may send every row
    it shows, ``execute`` included. Baselines come from the agents service's
    rows *before* the user's choices are applied, so a choice that matches the
    agent's default stores nothing.
    """
    slug = await _resolve_agent_slug(db, user_id, agent_id)
    manifest = await _fetch_tool_manifest(db, user_id, slug)
    rows = {str(r.get("key")): r for r in (manifest.get("tools") or [])}

    writes: list[tuple[str, bool | None, bool]] = []
    for tool_key, required in approvals.items():
        row = rows.get(tool_key)
        if row is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="That tool is not available for this agent.",
            )
        baseline = bool(row.get("approval"))
        if row.get("approvalLocked"):
            if required is None or required == baseline:
                continue
            raise _locked_gate_conflict(row)
        writes.append((tool_key, required, baseline))

    try:
        for tool_key, required, baseline in writes:
            await agent_tool_prefs.set_approval(
                db, user_id, slug, tool_key, required=required, baseline=baseline
            )
        await db.commit()
    except Exception:
        await db.rollback()
        raise

    disabled, enabled, stored = await agent_tool_prefs.read_prefs(db, user_id, slug)
    manifest["tools"] = agent_tool_prefs.apply_to_rows(
        manifest.get("tools") or [], disabled, enabled, stored
    )
    return manifest
