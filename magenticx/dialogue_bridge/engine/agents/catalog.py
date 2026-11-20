"""The agent catalog: the platform-agent cache, the sync with the agents
service, the ownership-checked lookups, and the catalog lists (tools,
models, builtin tools) the agents service serves.
"""

from typing import Any, Dict, Iterable, List, Sequence
import httpx
from fastapi import HTTPException, status
from core.logging import get_context, get_logger
from sqlalchemy import or_, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql import func
from core.settings import settings
from core.security.tls import get_httpx_client_cert, get_httpx_verify
from core.database import AgentTable, SessionLocal
from core.security.internal_trust import internal_service_headers
from core.error_handling import upstream_error_handler
from engine.agents.service_urls import AGENTS_SERVICE_URL

logger = get_logger(__name__)


_AGENTS_DISCOVERY_ENDPOINT = f"{AGENTS_SERVICE_URL.rstrip('/')}/agents"
_AGENTS_TOOLS_ENDPOINT = f"{AGENTS_SERVICE_URL.rstrip('/')}/tools"
_AGENTS_MODELS_ENDPOINT = f"{AGENTS_SERVICE_URL.rstrip('/')}/models"
_AGENTS_BUILTIN_TOOLS_ENDPOINT = f"{AGENTS_SERVICE_URL.rstrip('/')}/builtin-tools"
_AGENT_CACHE: Dict[str, AgentTable] = {}


def prime_agent_cache(agents: Iterable[AgentTable]) -> None:
    """Store active **platform** agents for fast validation lookups.

    User-authored agents are deliberately excluded: this cache is process-global
    and ``get_cached_agents()`` feeds the catalog endpoint, so a user-owned row in
    here would be served to every other user. Their rows are read per-request
    from the database instead (:func:`list_user_agents`, :func:`get_usable_agent`).
    """
    global _AGENT_CACHE
    # Keep only active agents so downstream validators skip disabled ones.
    _AGENT_CACHE = {
        agent.id: agent
        for agent in agents
        if getattr(agent, "is_active", True) and getattr(agent, "owner_user_id", None) is None
    }


def get_cached_agents() -> List[AgentTable]:
    """Return cached active platform agents; empty list if cache not yet primed."""
    # Return a list copy to avoid callers mutating the internal cache.
    return list(_AGENT_CACHE.values())


async def list_user_agents(db: AsyncSession, user_id: str) -> List[AgentTable]:
    """The active agents this user authored. Never cached (see
    :func:`prime_agent_cache`)."""
    result = await db.execute(
        select(AgentTable)
        .where(AgentTable.owner_user_id == user_id, AgentTable.is_active == True)
        .order_by(AgentTable.name)
    )
    return list(result.scalars().all())


async def _load_active_agents(db: AsyncSession) -> List[AgentTable]:
    # Active *platform* agents only — this feeds the process-global cache, which
    # must never hold a user-owned row (see prime_agent_cache).
    result = await db.execute(
        select(AgentTable).where(
            AgentTable.is_active == True,
            AgentTable.owner_user_id.is_(None),
        )
    )
    return list(result.scalars().all())


async def sync_agents_with_service(db: AsyncSession) -> List[AgentTable]:
    """
    Discover agents from the agents service, upsert them into the database, and
    toggle their active status. If the agents service is unreachable, surface a 503.
    """
    manifests: Sequence[Dict[str, Any]] | None = None
    timeout = settings.http.agents_timeout
    request_id = get_context().get("request_id")
    upstream_headers = internal_service_headers(request_id)
    try:
        # Pull the latest agent manifests from the agents service.
        async with httpx.AsyncClient(timeout=timeout, verify=get_httpx_verify(), cert=get_httpx_client_cert()) as client:
            resp = await upstream_error_handler.run_with_retries(
                logger,
                lambda: client.get(_AGENTS_DISCOVERY_ENDPOINT, headers=upstream_headers),
                upstream_service="agents",
                operation="agent_sync",
            )
            resp.raise_for_status()
    except httpx.HTTPStatusError as exc:
        upstream_error_handler.raise_http_error(
            logger,
            exc,
            event="agents_sync_failed",
            message="Agents service returned an HTTP error during agent synchronization",
            public_detail="Agent service could not refresh the available agents. Please try again.",
            upstream_service="agents",
            operation="agent_sync",
        )
    except httpx.RequestError as exc:
        upstream_error_handler.raise_request_error(
            logger,
            exc,
            event="agents_sync_unreachable",
            message="Failed to reach agents service during agent synchronization",
            public_detail="Agent service is temporarily unavailable. Please try again shortly.",
            upstream_service="agents",
            operation="agent_sync",
        )

    try:
        data = resp.json()
    except ValueError as exc:
        upstream_error_handler.raise_invalid_response(
            logger,
            exc,
            event="agents_sync_invalid_json",
            message="Agents service returned invalid JSON during agent synchronization",
            public_detail="Agent service returned an unexpected response. Please try again.",
            upstream_service="agents",
            operation="agent_sync",
        )

    if isinstance(data, list):
        manifests = data
    else:
        upstream_error_handler.raise_invalid_response(
            logger,
            event="agents_sync_invalid_payload",
            message="Agents service returned an unexpected discovery payload",
            public_detail="Agent service returned an unexpected response. Please try again.",
            upstream_service="agents",
            operation="agent_sync",
            payload_type=type(data).__name__,
        )

    manifest_ids: set[str] = set()
    for manifest in manifests or []:
        # Validate basic manifest fields before attempting an upsert.
        agent_id = manifest.get("id")
        slug = manifest.get("slug") or manifest.get("name") or agent_id
        if not agent_id or not slug:
            logger.warning("agents_sync_skipped_manifest", "Skipping agent manifest missing id or slug", upstream_service="agents", manifest_keys=sorted(manifest.keys()) if isinstance(manifest, dict) else None)
            continue
        manifest_ids.add(str(agent_id))

        agent_type = manifest.get("type") or "langgraph agent"

        # Upsert each manifest to keep DB rows aligned with the remote service.
        stmt = (
            insert(AgentTable)
            .values(
                id=str(agent_id),
                slug=str(slug),
                name=manifest.get("name") or str(agent_id),
                description=manifest.get("description") or "",
                icon=manifest.get("icon") or "",
                version=manifest.get("version"),
                type=agent_type,
                is_active=True,
            )
            .on_conflict_do_update(
                index_elements=["id"],
                set_={
                    "slug": str(slug),
                    "name": manifest.get("name") or str(agent_id),
                    "description": manifest.get("description") or "",
                    "icon": manifest.get("icon") or "",
                    "version": manifest.get("version"),
                    "type": agent_type,
                    "is_active": True,
                    "updated_at": func.now(),  # type: ignore[name-defined]
                },
            )
        )
        await db.execute(stmt)

    # Deactivate platform agents that vanished from the manifest — but NEVER
    # touch user-authored agents. They are created through the bridge and their
    # definitions are stored per user by the agents service, so they are absent
    # from its platform manifest by design; without the owner filter every sync
    # would silently deactivate every custom agent a user owns.
    if manifest_ids:
        await db.execute(
            update(AgentTable)
            .where(
                AgentTable.owner_user_id.is_(None),
                AgentTable.id.notin_(list(manifest_ids)),
            )
            .values(is_active=False)
        )
    else:
        await db.execute(
            update(AgentTable)
            .where(AgentTable.owner_user_id.is_(None))
            .values(is_active=False)
        )

    # Persist changes, refresh cache, and return the new active list.
    await db.commit()
    refreshed = await _load_active_agents(db)
    prime_agent_cache(refreshed)
    logger.info("agents_sync_completed", "Agent synchronization completed", upstream_service="agents", active_agents=len(refreshed), discovered_manifests=len(manifest_ids))
    return refreshed


async def get_agent_by_id(agent_id: str) -> AgentTable | None:
    """Fetch an agent from cache or database without enforcing validation semantics.

    The cache covers platform agents only, so a miss is not "no such agent" — a
    user-authored agent is never cached, and one created after boot would be
    invisible without this fallback (the cache refreshes only on an agents-service
    sync). Falls through to a short-lived session read; returns ``None`` only when
    the row genuinely does not exist or is inactive.
    """
    # Prefer the in-memory cache for constant-time lookups during API calls.
    agent = _AGENT_CACHE.get(agent_id)
    if agent is not None and getattr(agent, "is_active", True):
        return agent

    try:
        async with SessionLocal() as db:
            result = await db.execute(
                select(AgentTable).where(
                    AgentTable.id == agent_id,
                    AgentTable.is_active == True,
                )
            )
            return result.scalar_one_or_none()
    except SQLAlchemyError:
        # A database problem must not turn a lookup helper — called on many read
        # paths, where None already means "404 unknown agent" — into an
        # unhandled 500. Degrade to not-found and log loudly so the real cause
        # is diagnosable.
        logger.warning(
            "agent_lookup_db_failed",
            "Agent lookup fell back to the database and failed; treating as unknown",
            exc_info=True,
            agent_id=agent_id,
        )
        return None


async def get_usable_agent(
    db: AsyncSession | None, user_id: str, agent_id: str | None
) -> AgentTable:
    """The agent ``agent_id`` names, if this user may use it; 404 otherwise.

    Usable means an active platform agent (``owner_user_id IS NULL``) or one of
    the caller's own active agents. Someone else's agent gets the same 404 as
    an id that does not exist (like ``_require_owned_row``), so a guessed id
    reveals nothing, not even that it is taken. Every user-facing path that
    takes an agent id goes through this. :func:`get_agent_by_id` stays for the
    internal paths that have no user to check against.

    ``db`` is the request's session when there is one. ``None`` opens a
    short-lived session, for the upstream proxy helpers that do not hold one.
    """
    if agent_id:
        # The cache holds active platform agents only (see prime_agent_cache),
        # so a hit is usable by anyone.
        cached = _AGENT_CACHE.get(agent_id)
        if cached is not None and getattr(cached, "is_active", True):
            return cached
        stmt = select(AgentTable).where(
            AgentTable.id == agent_id,
            AgentTable.is_active.is_(True),
            or_(AgentTable.owner_user_id.is_(None), AgentTable.owner_user_id == user_id),
        )
        if db is None:
            async with SessionLocal() as session:
                agent = (await session.execute(stmt)).scalar_one_or_none()
        else:
            agent = (await db.execute(stmt)).scalar_one_or_none()
        if agent is not None:
            return agent
    raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Agent not found.")


async def _fetch_catalog_list(
    endpoint: str,
    *,
    operation: str,
    noun: str,
    not_found_detail: str | None = None,
) -> list[dict[str, Any]]:
    """GET one list-shaped catalog from the agents service, uncached.

    ``noun`` names the catalog in the public error text ("Tool catalog").
    ``not_found_detail`` turns an upstream 404 into a clean 404 rather than a
    502, for catalogs a newer agents service adds: the bridge may be deployed
    first, and the UI falls back to its own list until the route exists.
    """
    timeout = settings.http.agents_timeout
    upstream_headers = internal_service_headers(get_context().get("request_id"))
    try:
        async with httpx.AsyncClient(timeout=timeout, verify=get_httpx_verify(), cert=get_httpx_client_cert()) as client:
            resp = await upstream_error_handler.run_with_retries(
                logger,
                lambda: client.get(endpoint, headers=upstream_headers),
                upstream_service="agents",
                operation=operation,
            )
            resp.raise_for_status()
    except httpx.HTTPStatusError as exc:
        if not_found_detail and exc.response.status_code == status.HTTP_404_NOT_FOUND:
            logger.info(
                f"{operation}_not_served",
                "Agents service does not serve this catalog yet",
                upstream_service="agents",
                operation=operation,
            )
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=not_found_detail) from exc
        upstream_error_handler.raise_http_error(
            logger,
            exc,
            event=f"{operation}_failed",
            message=f"Agents service returned an HTTP error while fetching the {noun.lower()}",
            public_detail=f"{noun} could not be refreshed. Please try again.",
            upstream_service="agents",
            operation=operation,
        )
    except httpx.RequestError as exc:
        upstream_error_handler.raise_request_error(
            logger,
            exc,
            event=f"{operation}_unreachable",
            message=f"Failed to reach agents service while fetching the {noun.lower()}",
            public_detail=f"{noun} is temporarily unavailable. Please try again shortly.",
            upstream_service="agents",
            operation=operation,
        )

    try:
        payload = resp.json()
    except ValueError as exc:
        upstream_error_handler.raise_invalid_response(
            logger,
            exc,
            event=f"{operation}_invalid_json",
            message=f"Agents service returned invalid JSON for the {noun.lower()}",
            public_detail=f"{noun} returned an unexpected response. Please try again.",
            upstream_service="agents",
            operation=operation,
        )

    if not isinstance(payload, list):
        # The UI expects a bare list; enforce here for better errors.
        upstream_error_handler.raise_invalid_response(
            logger,
            event=f"{operation}_invalid_payload",
            message=f"Agents service returned an unexpected {noun.lower()} payload",
            public_detail=f"{noun} returned an unexpected response. Please try again.",
            upstream_service="agents",
            operation=operation,
            payload_type=type(payload).__name__,
        )

    return payload


async def fetch_tools_from_agents_service() -> List[Dict[str, Any]]:
    """Proxy the agents service `/tools` endpoint (MCP tool manifests) without caching."""
    return await _fetch_catalog_list(
        _AGENTS_TOOLS_ENDPOINT, operation="tools_fetch", noun="Tool catalog"
    )


async def fetch_models_from_agents_service() -> list[dict[str, Any]]:
    """The models a user agent may run on, in the agents service's order."""
    return await _fetch_catalog_list(
        _AGENTS_MODELS_ENDPOINT,
        operation="models_fetch",
        noun="Model list",
        not_found_detail="The model list is not available yet.",
    )


async def fetch_builtin_tools_from_agents_service() -> list[dict[str, Any]]:
    """The built-in tools a draft agent can be given, with their approval rules."""
    return await _fetch_catalog_list(
        _AGENTS_BUILTIN_TOOLS_ENDPOINT,
        operation="builtin_tools_fetch",
        noun="Built-in tool list",
        not_found_detail="The built-in tool list is not available yet.",
    )
