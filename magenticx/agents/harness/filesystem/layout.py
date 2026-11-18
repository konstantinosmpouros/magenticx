"""Single authority for every path on the agents filesystem.

What is left on disk is the **global plane** — the consolidated layout from
``plans/18-workspace-filesystem-consolidation.md``::

    $MAGENTICX_GLOBAL_ROOT/                         ← platform-owned, shared
        agents/<agent_slug>/                        agent definition
            agent.yaml · AGENT.md · subagents/
            skills/<skill_name>/                    DEFAULT skills (tier ①)
        skills/<category>/<skill_name>/SKILL.md     browsable catalogue

It is **build-time** content — baked into the image, identical for every
user, never written at runtime — so a database would add nothing. Everything a
user or a run produces lives in a database instead: per-agent tool choices in
``chat_db`` (``user_agent_tool_prefs``), and in ``agent_runtime`` memory
(``agent_memories``), the skill pool, custom skill files and assignments
(``skill_pool`` / ``skill_files`` / ``agent_skills``), user-authored agent
definitions (``agent_definitions`` / ``agent_definition_files``) and every
conversation's files (``conversation_files``, plan 36). None of them has a path
here.
"""
from __future__ import annotations

from pathlib import Path

from core.settings import settings


def safe_segment(value: str) -> str:
    """Reject IDs that could break out of their intended directory.

    UUIDs from the bridge are safe by construction, but an id or slug that
    becomes a path component is an input to a path operation — validating it
    is cheap defense in depth against any future caller that supplies a
    different ID shape.
    """
    if (
        not value
        or "/" in value
        or "\\" in value
        or ".." in value
        or value.startswith(".")
    ):
        raise ValueError(f"Illegal path segment: {value!r}")
    return value


# ---------------------------------------------------------------------------
# Global plane
# ---------------------------------------------------------------------------
def global_root() -> Path:
    """Root of the shared plane (definitions + catalogues)."""
    return settings.filesystem.global_root


def global_agents_root() -> Path:
    """Where platform agent definition folders are discovered (none ship in
    the image any more; see ``harness.filesystem.retired_agents``)."""
    return global_root() / "agents"


def global_agent_dir(agent_slug: str) -> Path:
    """One platform agent's definition folder."""
    return global_agents_root() / safe_segment(agent_slug)


def global_agent_default_skills_root(agent_slug: str) -> Path:
    """Tier ① skills a platform agent ships with — mounted read-only, never
    copied into a user's tree, so a user cannot disable them."""
    return global_agent_dir(agent_slug) / "skills"


def platform_skills_root() -> Path | None:
    """The skills every deep agent gets (plan 44), or ``None`` when the tier is
    switched off or the folder is missing. Build-time content in the image,
    mounted read-only at ``/platform_skills/``."""
    cfg = settings.filesystem
    root = cfg.platform_skills_root
    return root if cfg.platform_skills_enabled and root.is_dir() else None


def global_skills_root() -> Path:
    """The admin-curated skills catalogue (``<category>/<skill>/SKILL.md``)."""
    return global_root() / "skills"


__all__ = [
    "global_agent_default_skills_root",
    "global_agent_dir",
    "global_agents_root",
    "global_root",
    "global_skills_root",
    "platform_skills_root",
    "safe_segment",
]
