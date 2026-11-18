"""The one-shot prune of retired platform agents from the global volume.

**One-shot: delete this file with ``harness/filesystem/retired_agents.py`` in the
release after the one that ships it.**

What is pinned here:

* ``omni-yaml-v1``'s folder is removed, and a registry re-scan then no longer
  lists it;
* an absent folder is a silent no-op, and a second boot removes nothing;
* only the retired slug goes — a sibling agent folder is untouched;
* a symlink or a plain file at the retired path is refused, never followed or
  deleted.
"""
from __future__ import annotations

import importlib

import pytest

RETIRED = "omni-yaml-v1"

_AGENT_YAML = """\
id: {slug}
slug: {slug}
name: Probe
version: 1.0.0
type: deep_agent
prompt: ./AGENT.md
model:
  main: openai:probe-model
"""


@pytest.fixture
def prune(agents_service, tmp_path):
    """The pruner, with the global plane redirected into ``tmp_path``."""
    agents_service.settings_module.settings.filesystem.global_root = tmp_path / "global"
    return importlib.import_module("harness.filesystem.retired_agents")


def _agent_dir(agents_service, slug: str):
    folder = agents_service.filesystem_layout.global_agents_root() / slug
    (folder / "subagents").mkdir(parents=True)
    (folder / "agent.yaml").write_text(_AGENT_YAML.format(slug=slug), encoding="utf-8")
    (folder / "AGENT.md").write_text("You are a probe.", encoding="utf-8")
    (folder / "subagents" / "writer.md").write_text("You write.", encoding="utf-8")
    return folder


def test_the_retired_folder_is_removed_and_leaves_the_registry(agents_service, prune):
    folder = _agent_dir(agents_service, RETIRED)
    utils_agents = agents_service.agents_utils
    utils_agents.refresh_registry()
    assert RETIRED in utils_agents.AGENT_REGISTRY

    assert prune.prune_retired_platform_agents() == [RETIRED]

    assert not folder.exists()
    utils_agents.refresh_registry()
    assert RETIRED not in utils_agents.AGENT_REGISTRY


def test_an_absent_folder_is_a_no_op_and_a_second_boot_removes_nothing(agents_service, prune):
    assert prune.prune_retired_platform_agents() == []
    _agent_dir(agents_service, RETIRED)
    assert prune.prune_retired_platform_agents() == [RETIRED]
    assert prune.prune_retired_platform_agents() == []


def test_only_the_retired_slug_goes(agents_service, prune):
    _agent_dir(agents_service, RETIRED)
    keeper = _agent_dir(agents_service, "keeper-v1")

    prune.prune_retired_platform_agents()

    assert (keeper / "agent.yaml").is_file()
    assert (keeper / "subagents" / "writer.md").is_file()


def test_a_plain_file_at_the_retired_path_is_refused(agents_service, prune):
    root = agents_service.filesystem_layout.global_agents_root()
    root.mkdir(parents=True)
    stray = root / RETIRED
    stray.write_text("not a folder", encoding="utf-8")

    assert prune.prune_retired_platform_agents() == []
    assert stray.read_text(encoding="utf-8") == "not a folder"


def test_a_symlink_at_the_retired_path_is_refused_and_its_target_kept(
    agents_service, prune, tmp_path
):
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    (elsewhere / "precious.txt").write_text("keep me", encoding="utf-8")
    root = agents_service.filesystem_layout.global_agents_root()
    root.mkdir(parents=True)
    link = root / RETIRED
    try:
        link.symlink_to(elsewhere, target_is_directory=True)
    except OSError:
        pytest.skip("this host cannot create symlinks")

    assert prune.prune_retired_platform_agents() == []
    assert link.is_symlink()
    assert (elsewhere / "precious.txt").read_text(encoding="utf-8") == "keep me"
