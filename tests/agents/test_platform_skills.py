"""Platform skills (plan 44): the document skills every deep agent gets.

Pinned here:

* the tier follows one answer (``layout.platform_skills_root``): the setting on
  and the folder present; the mount, the write-deny rule, the skills source and
  the prompt line all derive from it;
* it is mounted read-only straight from the image folder, so a run reads the
  skills and can never change them;
* it is the lowest-precedence source: an agent's own or a user's skill of the
  same name wins;
* the shipped folder holds the four skills, each with its licence, and the
  upstream commit they were taken from.
"""
from __future__ import annotations

import importlib
import importlib.util
from pathlib import Path
from types import SimpleNamespace

import pytest
from deepagents.backends import FilesystemBackend

REPO = Path(__file__).resolve().parents[2]
SHIPPED = REPO / "magenticx" / "agents" / "harness" / "skill_registry" / "platform_skills"
DOCUMENT_SKILLS = ("docx", "xlsx", "pptx", "pdf")


@pytest.fixture()
def workspace(agents_service):
    return importlib.import_module("harness.filesystem.workspace")


@pytest.fixture()
def layout(agents_service):
    return importlib.import_module("harness.filesystem.layout")


@pytest.fixture()
def settings(agents_service):
    return importlib.import_module("core.settings").settings


def _files():
    package = importlib.import_module("harness.conversation_files")
    return package.ConversationFiles(
        user_id="user-1", conversation_id="conv-1", agent_slug="agent-1",
        store=package.ConversationFileStore(object()),
    )


def _backend(workspace, platform_skills_dir=None):
    return workspace.build_workspace_backend(
        user_id="user-1", agent_slug="agent-1", files=_files(), use_memory=False,
        platform_skills_dir=platform_skills_dir,
    )(None)


def _skill_tree(root: Path) -> Path:
    skill = root / "docx"
    skill.mkdir(parents=True)
    (skill / "SKILL.md").write_text("---\nname: docx\ndescription: Word files\n---\nBody\n", encoding="utf-8")
    return root


# ------------------------------------------------------------------ the one answer
def test_the_tier_needs_the_setting_and_the_folder(layout, settings, monkeypatch, tmp_path):
    monkeypatch.setattr(settings.filesystem, "platform_skills_root", tmp_path / "missing")
    assert layout.platform_skills_root() is None
    root = _skill_tree(tmp_path / "skills")
    monkeypatch.setattr(settings.filesystem, "platform_skills_root", root)
    assert layout.platform_skills_root() == root
    monkeypatch.setattr(settings.filesystem, "platform_skills_enabled", False)
    assert layout.platform_skills_root() is None


# ---------------------------------------------------------------------- the mount
def test_the_mount_is_the_image_folder_and_reads_the_skill(workspace, skills_fs, tmp_path):
    assert "/platform_skills/" not in _backend(workspace).routes
    route = _backend(workspace, _skill_tree(tmp_path / "skills")).routes["/platform_skills/"]
    assert isinstance(route, FilesystemBackend)
    assert "name: docx" in str(route.read("/docx/SKILL.md").file_data)


def test_the_mount_is_read_only_and_its_rule_needs_the_mount(workspace, skills_fs, tmp_path):
    def denies_platform(rules) -> bool:
        return any(rule.mode == "deny" and "write" in rule.operations
                   and any(path.startswith("/platform_skills") for path in rule.paths) for rule in rules)

    assert not denies_platform(workspace.workspace_write_deny())
    rules = workspace.workspace_write_deny(include_platform_skills=True)
    assert denies_platform(rules)
    mounted = {prefix.strip("/").split("/")[0]
               for prefix in _backend(workspace, _skill_tree(tmp_path / "skills")).routes}
    assert all(path.lstrip("/").split("{")[0].split("/")[0] in mounted for rule in rules for path in rule.paths)


# -------------------------------------------------------------- the skills source
def test_platform_skills_are_the_lowest_precedence_source(agents_service):
    deep_agent = importlib.import_module("harness.abstractions.deep_agent").DeepAgent
    with_all = SimpleNamespace(platform_skills_dir=Path("/x"), _has_default_skills=True)
    assert deep_agent.load_skills(with_all) == [
        ("/platform_skills/", "Platform"), ("/skills/", "Your"), ("/default_skills/", "Built-in"),
    ]
    switched_off = SimpleNamespace(platform_skills_dir=None, _has_default_skills=False)
    assert deep_agent.load_skills(switched_off) == [("/skills/", "Your")]


def test_the_prompt_names_the_mount_only_when_mounted(agents_service):
    pe = importlib.import_module("harness.prompt_engineering")
    on = pe.compose_system_prompt("", pe.PromptContext(has_conversation=True, has_platform_skills=True))
    off = pe.compose_system_prompt("", pe.PromptContext(has_conversation=True))
    assert "`/platform_skills/`" in on and "/platform_skills/<skill>/scripts/" in on
    assert "/platform_skills/" not in off


# ------------------------------------------------------------------ the shipped folder
def _load_builder():
    spec = importlib.util.spec_from_file_location("platform_skills_builder", REPO / "scripts" / "platform_skills.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


BUILDER = _load_builder()


@pytest.mark.parametrize("name", DOCUMENT_SKILLS)
def test_each_document_skill_ships_with_its_licence_and_changes(name):
    skill = SHIPPED / name
    front = (skill / "SKILL.md").read_text(encoding="utf-8")
    assert front.startswith(f"---\nname: {name}\n")
    assert "> **Platform notes (mAgenticX).**" in front
    assert f"/platform_skills/{name}/" in front
    assert "Apache License" in (skill / "LICENSE.txt").read_text(encoding="utf-8")
    assert "Changes made by mAgenticX" in (skill / "CHANGES.md").read_text(encoding="utf-8")


def test_the_tree_is_exactly_what_source_records():
    """A hand edit (or a half-run build) changes the hash: rebuild with
    scripts/platform_skills.py and copy the same tree to the sandbox box."""
    source = dict(line.split(" ", 1) for line in (SHIPPED / "SOURCE").read_text(encoding="utf-8").splitlines())
    assert source["repo"] == "https://github.com/anthropics/skills"
    assert len(source["commit"]) == 40
    assert source["tree"] == BUILDER.tree_hash(SHIPPED)


def test_the_shared_office_tooling_is_the_same_in_every_skill():
    def files(root: Path) -> dict[str, bytes]:
        return {p.relative_to(root).as_posix(): p.read_bytes()
                for p in root.rglob("*") if p.is_file() and "__pycache__" not in p.parts}

    docx = files(SHIPPED / "docx" / "scripts" / "office")
    assert docx and docx == files(SHIPPED / "xlsx" / "scripts" / "office") == files(SHIPPED / "pptx" / "scripts" / "office")
