"""The platform skills as the Skills tab shows them (plan 44).

:mod:`.platform` answers *which* platform skills exist; this module describes
each one for a person: its name and description (from the SKILL.md front
matter), the licence its ``LICENSE.txt`` carries, where it came from (the repo
and commit ``SOURCE`` pins) and how many files it ships. The routes in
``router/skills.py`` serve it read-only — a platform skill is always on for
every deep agent, so there is nothing to add, assign or remove.

Kept apart from :mod:`.platform` on purpose: it reuses the remote sync's
SKILL.md and licence checks (:mod:`.remote.sources`), and the sync itself
imports :mod:`.platform`, so putting these reads there would close a cycle.
"""
from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from urllib.parse import urlsplit

from core.logging import get_logger
from harness.skill_registry.platform import PlatformSkills, platform_skills
from harness.skill_registry.remote.sources import check_skill_md, detect_licence_text
from schema import PlatformSkill, PlatformSkillDetail

logger = get_logger(__name__)

#: The licence file every platform skill ships next to its SKILL.md.
_LICENCE_FILE = "LICENSE.txt"
#: Build leftovers that are not part of a skill, never counted as its files.
_IGNORED_DIRS = frozenset({"__pycache__"})


class PlatformSkillNotFound(LookupError):
    """No platform skill of that name (or the tier is off)."""


@dataclass(frozen=True)
class _Described:
    """One platform skill read from disk: the public row plus its SKILL.md."""

    row: PlatformSkill
    skill_md: str


def _source_label(repo: str) -> str:
    """``https://github.com/anthropics/skills`` → ``anthropics/skills``."""
    path = urlsplit(repo).path.strip("/") if repo else ""
    return path or repo


def _upstream_url(repo: str, commit: str, name: str) -> str | None:
    """The skill's folder upstream at the pinned commit, for a GitHub https repo only.

    Anthropic's repo keeps each skill under ``skills/<name>``; any other shape
    gets no link rather than a guessed one.
    """
    parts = urlsplit(repo)
    if parts.scheme != "https" or parts.netloc != "github.com" or not commit:
        return None
    return f"{repo.rstrip('/')}/tree/{commit}/skills/{name}"


def _file_count(folder: Path) -> int:
    """How many files the skill ships, build leftovers excluded."""
    return sum(
        1
        for path in folder.rglob("*")
        if path.is_file() and not _IGNORED_DIRS.intersection(path.relative_to(folder).parts)
    )


def _licence(folder: Path) -> str | None:
    """The licence the skill's own ``LICENSE.txt`` carries, recognised by its wording."""
    licence_file = folder / _LICENCE_FILE
    if not licence_file.is_file():
        return None
    return detect_licence_text(licence_file.read_text(encoding="utf-8", errors="replace"))


def _describe(platform: PlatformSkills, name: str) -> _Described | None:
    """Read one platform skill, or ``None`` when its SKILL.md would not load.

    A SKILL.md the agent would skip is not shown as a skill the agent has — the
    same check the remote sync applies before admitting anything.
    """
    folder = platform.root / name
    raw = (folder / "SKILL.md").read_bytes()
    check = check_skill_md(raw, name)
    if check.refusal is not None:
        logger.warning(
            "platform_skill_unreadable",
            "A platform skill's SKILL.md would not load; it is not listed",
            skill=name,
            reason=check.refusal,
        )
        return None
    row = PlatformSkill(
        name=check.name,
        description=check.description,
        licence=_licence(folder),
        source_label=_source_label(platform.repo),
        source_repo=platform.repo,
        source_commit=platform.commit,
        upstream_url=_upstream_url(platform.repo, platform.commit, name),
        file_count=_file_count(folder),
    )
    return _Described(row=row, skill_md=raw.decode("utf-8"))


def _describe_all(platform: PlatformSkills) -> tuple[_Described, ...]:
    """Every readable platform skill, by name."""
    return _describe_cached(platform.root, platform.repo, platform.commit, platform.names)


@lru_cache(maxsize=4)
def _describe_cached(root: Path, repo: str, commit: str, names: frozenset[str]) -> tuple[_Described, ...]:
    """The folder ships with the image and never changes while the process runs,
    so one read is enough. Keyed on the hashable parts of :class:`PlatformSkills`
    (its ``upstream`` map is a dict, so the object itself cannot be a key)."""
    platform = PlatformSkills(root=root, repo=repo, commit=commit, names=names)
    described = (_describe(platform, name) for name in sorted(names))
    return tuple(item for item in described if item is not None)


def list_platform_skills() -> list[PlatformSkill]:
    """The platform skills every deep agent gets; empty when the tier is off."""
    platform = platform_skills()
    if platform is None:
        return []
    return [item.row for item in _describe_all(platform)]


def get_platform_skill(name: str) -> PlatformSkillDetail:
    """One platform skill with its full SKILL.md text, for the read-only viewer.

    Looked up among the skills listed, never by joining ``name`` onto a path,
    so nothing outside the platform folder can be read through it.
    """
    platform = platform_skills()
    if platform is not None:
        for item in _describe_all(platform):
            if item.row.name == name:
                return PlatformSkillDetail(**item.row.model_dump(), content=item.skill_md)
    raise PlatformSkillNotFound(f"No platform skill named {name!r}.")


__all__ = ["PlatformSkillNotFound", "get_platform_skill", "list_platform_skills"]
