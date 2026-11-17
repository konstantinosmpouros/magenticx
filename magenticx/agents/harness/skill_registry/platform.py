"""Platform skills in the registry (plan 44).

The platform ships a few skills itself, in this package's ``platform_skills/``
folder: Anthropic's document skills (docx, xlsx, pptx, pdf), adapted to this
platform by ``scripts/platform_skills.py`` and pinned by its ``SOURCE`` file.
Every deep agent mounts them read-only at ``/platform_skills/``, and the sandbox
box carries the same bytes at the same path.

They live **locally, never in Postgres**. A remote source that offers a skill of
the same name gets it catalogued as refused with ``PLATFORM_REFUSAL``: no files
stored, not searchable, not addable, so nobody holds a second, unadapted copy.
When the remote sync sees that the upstream content of a platform skill changed,
it logs ``platform_skill_update_available``; the update is made locally by
re-running ``scripts/platform_skills.py update`` (and released like code).

Read straight from ``core.settings`` (not ``harness.filesystem.layout``): the
filesystem package imports the skill store while it initialises, so importing it
from here would close a cycle.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path

from core.settings import settings

#: The refusal a remote skill gets when the platform ships a skill of its name.
PLATFORM_REFUSAL = "a platform skill"


@dataclass(frozen=True)
class PlatformSkills:
    """What ``platform_skills/SOURCE`` records, plus the skills on disk."""

    root: Path
    repo: str = ""
    commit: str = ""
    names: frozenset[str] = frozenset()
    #: ``name → content ref`` of the upstream version each skill was built from,
    #: in the remote sync's own terms (``content_ref_for``).
    upstream: dict[str, str] = field(default_factory=dict)

    def covers(self, *names: str | None) -> bool:
        """Whether a remote skill (by id or display name) is one of these."""
        return any(name in self.names for name in names if name)

    def is_upstream_repo(self, repo: str | None) -> bool:
        """Whether a remote source's ``owner/repo`` is where these came from."""
        return bool(repo) and self.repo.rstrip("/").endswith("/" + str(repo).strip("/"))


@lru_cache(maxsize=4)
def _read(root: Path) -> PlatformSkills:
    names = frozenset(p.name for p in root.iterdir() if (p / "SKILL.md").is_file())
    source: dict[str, str] = {}
    source_file = root / "SOURCE"
    if source_file.is_file():
        for line in source_file.read_text(encoding="utf-8").splitlines():
            key, _, value = line.partition(" ")
            source[key] = value.strip()
    upstream = {key.removeprefix("upstream:"): value for key, value in source.items() if key.startswith("upstream:")}
    return PlatformSkills(root=root, repo=source.get("repo", ""), commit=source.get("commit", ""),
                          names=names, upstream=upstream)


def platform_skills() -> PlatformSkills | None:
    """The platform skills, or ``None`` when the tier is off or the folder is missing."""
    cfg = settings.filesystem
    root = cfg.platform_skills_root
    if not cfg.platform_skills_enabled or not root.is_dir():
        return None
    return _read(root)


__all__ = ["PLATFORM_REFUSAL", "PlatformSkills", "platform_skills"]
