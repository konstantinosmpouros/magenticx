"""One-shot: remove retired platform agents' folders from the global volume.

**Delete this module in the release after the one that ships it**, with its call
in ``main.py`` and ``tests/agents/test_retired_agents_prune.py`` — the pattern
of the one-shot pruners of plans 25 and 26: it runs during one deploy, then goes.

``omni-yaml-v1``, the declarative twin of the Python Omni agent, was the only
agent the image ever seeded onto ``$MAGENTICX_GLOBAL_ROOT/agents/``. The seed and
its boot-time copy are gone, but a volume seeded before still holds the folder,
and the registry discovers every ``agents/<slug>/agent.yaml`` it finds there.
This runs in the lifespan before ``refresh_registry()``, so the agent leaves
``AGENT_REGISTRY`` on the deploy that drops it, and the bridge's next catalog
sync marks its row inactive (conversations keep it; nothing is deleted there).

It touches only the slugs in :data:`RETIRED_PLATFORM_AGENTS`, each one a real
directory directly under the agents root: a symlink, a plain file or a path that
resolves anywhere else is refused and logged, never followed. Idempotent — an
absent folder is a silent no-op. A failure is logged and never fatal: the worst
case is the agent staying listed until the next boot.
"""
from __future__ import annotations

import shutil

from core.logging import get_logger
from harness.filesystem import layout

logger = get_logger(__name__)

#: The platform agents whose volume folders this deploy removes.
RETIRED_PLATFORM_AGENTS: tuple[str, ...] = ("omni-yaml-v1",)


def prune_retired_platform_agents() -> list[str]:
    """Remove each retired agent's folder from the volume. Returns the slugs removed."""
    root = layout.global_agents_root()
    removed: list[str] = []
    refused: list[str] = []
    for slug in RETIRED_PLATFORM_AGENTS:
        target = layout.global_agent_dir(slug)
        if not target.is_symlink() and not target.exists():
            continue
        if (
            target.is_symlink()
            or not target.is_dir()
            or target.resolve().parent != root.resolve()
        ):
            refused.append(slug)
            continue
        try:
            shutil.rmtree(target)
        except OSError:
            logger.warning(
                "retired_platform_agent_prune_failed",
                "Could not remove a retired platform agent's folder from the volume",
                exc_info=True,
                agent_slug=slug,
                path=str(target),
            )
            continue
        removed.append(slug)

    if refused:
        logger.warning(
            "retired_platform_agent_prune_refused",
            "Left a retired platform agent's path alone: not a plain directory under the agents root",
            agents=refused,
            root=str(root),
        )
    if removed:
        logger.info(
            "retired_platform_agents_pruned",
            "Removed retired platform agents from the volume",
            agents=removed,
            root=str(root),
        )
    return removed


__all__ = ["RETIRED_PLATFORM_AGENTS", "prune_retired_platform_agents"]
