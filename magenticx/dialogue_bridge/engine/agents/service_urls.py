"""URLs of the agents service's endpoints the bridge calls.

One place builds them, so the base URL and the per-agent slug checks are
applied the same way by every caller.
"""

from fastapi import HTTPException, status
from core.logging import get_logger
from core.settings import settings
from core.database import AgentTable

logger = get_logger(__name__)

AGENTS_SERVICE_URL = settings.upstream.agents_service_url


def build_agent_stream_url(agent: AgentTable) -> str:
    """Return the streaming endpoint for a given agent slug."""
    # Normalize base URL to avoid double slashes before attaching slug.
    if agent is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Agent metadata unavailable for this conversation",
        )

    slug = getattr(agent, "slug", None)
    if not slug:
        logger.error(
            "agent_stream_url_missing_slug",
            "Agent stream URL could not be built because slug is missing",
            agent_id=getattr(agent, "id", None),
            failure_reason="agent_slug_missing",
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Agent configuration is incomplete. Please try another agent or try again later.",
        )
    return f"{AGENTS_SERVICE_URL.rstrip('/')}/agents/{slug}/stream"


def build_agent_resume_url(agent: AgentTable) -> str:
    """Return the HITL resume endpoint for a given agent slug."""
    if agent is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Agent metadata unavailable for this conversation",
        )

    slug = getattr(agent, "slug", None)
    if not slug:
        logger.error(
            "agent_resume_url_missing_slug",
            "Agent resume URL could not be built because slug is missing",
            agent_id=getattr(agent, "id", None),
            failure_reason="agent_slug_missing",
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Agent configuration is incomplete. Please try another agent or try again later.",
        )
    return f"{AGENTS_SERVICE_URL.rstrip('/')}/agents/{slug}/resume"


def build_conversation_files_url(user_id: str, conversation_id: str) -> str:
    """A conversation's files in the agents service (plan 36): keyed by the
    conversation, never by agent — the files belong to the conversation."""
    base = AGENTS_SERVICE_URL.rstrip("/")
    return f"{base}/users/{user_id}/conversations/{conversation_id}/files"


def build_conversation_sources_url(user_id: str, conversation_id: str) -> str:
    """A conversation's citation sources in the agents service (plan 42):
    keyed by the conversation, like its files — copied on fork, deleted with it."""
    base = AGENTS_SERVICE_URL.rstrip("/")
    return f"{base}/users/{user_id}/conversations/{conversation_id}/sources"


def build_conversation_documents_url(user_id: str, conversation_id: str) -> str:
    """A conversation's canvas documents in the agents service (plan 44): their
    versions are keyed by the conversation, like its files."""
    base = AGENTS_SERVICE_URL.rstrip("/")
    return f"{base}/users/{user_id}/conversations/{conversation_id}/documents"


def build_conversation_office_preview_url(user_id: str, conversation_id: str) -> str:
    """POST endpoint that renders an Office attachment as a PDF in the sandbox
    box (plan 44, Phase 4.5); the conversation is the runner's audit key."""
    base = AGENTS_SERVICE_URL.rstrip("/")
    return f"{base}/users/{user_id}/conversations/{conversation_id}/office-preview"


def build_conversation_reap_url(user_id: str, conversation_id: str) -> str:
    """POST endpoint that drops a deleted conversation's threads and files."""
    base = AGENTS_SERVICE_URL.rstrip("/")
    return f"{base}/users/{user_id}/conversations/{conversation_id}/reap"


def build_agent_commands_url(agent: AgentTable, user_id: str) -> str:
    """GET endpoint listing the slash commands this agent offers this user (plan 35)."""
    slug = _require_agent_slug(agent)
    base = AGENTS_SERVICE_URL.rstrip("/")
    return f"{base}/commands/{user_id}/{slug}"


def build_agent_compact_url(agent: AgentTable) -> str:
    """POST endpoint that compacts a branch thread on request (plan 34)."""
    return f"{AGENTS_SERVICE_URL.rstrip('/')}/agents/{_require_agent_slug(agent)}/compact"


def build_agent_compact_undo_url(agent: AgentTable) -> str:
    """POST endpoint that undoes a manual compaction still at the branch's head."""
    return f"{AGENTS_SERVICE_URL.rstrip('/')}/agents/{_require_agent_slug(agent)}/compact/undo"


def _require_agent_slug(agent: AgentTable) -> str:
    if agent is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Agent metadata unavailable for this conversation",
        )
    slug = getattr(agent, "slug", None)
    if not slug:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Agent configuration is incomplete. Please try another agent or try again later.",
        )
    return slug
