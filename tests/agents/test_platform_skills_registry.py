"""Platform skills in the skill registry (plan 44).

The platform's document skills live locally (``harness/skill_registry/
platform_skills``), never in Postgres. Pinned here:

* a remote source offering a skill of a platform skill's name gets it
  catalogued as refused ("a platform skill"): no file read, no manifest, so it
  can never be found or added;
* every pass reconciles rows admitted before the platform shipped the skill
  (an unchanged source is otherwise skipped), and turning the tier off makes
  the source re-sync so its copy is admitted again;
* a newer upstream version is reported (``platform_skill_update_available``),
  never written: the update is local.
"""
from __future__ import annotations

import importlib

import httpx
import pytest
from test_remote_skills_sync import SHA_A, FakeGitHub, skill_md

PINNED = {"docx": "b8ae4d22f2fcfb000c089ca2da4d14fe3bdf3c9d2fcea5ca090f9b4f59869ce9"}


@pytest.fixture()
def registry(agents_service, skill_store_memory):
    platform = importlib.import_module("harness.skill_registry.platform")
    return type("Registry", (), {
        "sync": agents_service.remote_sync, "client": agents_service.remote_client,
        "sources": agents_service.remote_sources, "store": skill_store_memory, "platform": platform,
    })


async def _sync_anthropic(registry, gh: FakeGitHub):
    source = registry.sources.get_source("anthropic")
    async with registry.client.RemoteSkillClient(httpx.MockTransport(gh.handler)) as client:
        return await registry.sync.sync_source(registry.store, client, source)


def _admitted_row(registry, skill_id: str, content_ref: str = "old") -> None:
    registry.store.catalogue[("anthropic", skill_id)] = {
        "source_id": "anthropic", "skill_id": skill_id, "name": skill_id, "refusal": None,
        "withdrawn_at": None, "content_ref": content_ref, "source_ref": SHA_A,
    }
    registry.store.manifests[("anthropic", skill_id)] = [("SKILL.md", "f" * 40, 10)]
    registry.store.sources["anthropic"] = {"source_ref": SHA_A, "last_error": None}


def test_the_shipped_platform_skills_are_known_by_name(registry):
    platform = registry.platform.platform_skills()
    assert platform is not None
    assert platform.names == {"docx", "xlsx", "pptx", "pdf"}
    assert platform.is_upstream_repo("anthropics/skills") and not platform.is_upstream_repo("NVIDIA/skills")
    assert platform.upstream["docx"] == PINNED["docx"]


@pytest.mark.asyncio
async def test_a_remote_copy_of_a_platform_skill_is_catalogued_but_never_stored(registry):
    gh = FakeGitHub("anthropics/skills", SHA_A, {
        "skills/docx/SKILL.md": skill_md("docx"),
        "skills/docx/scripts/x.py": b"print(1)",
        "skills/other/SKILL.md": skill_md("other"),
    })
    await _sync_anthropic(registry, gh)

    docx = registry.store.catalogue[("anthropic", "docx")]
    assert docx["refusal"] == registry.platform.PLATFORM_REFUSAL
    assert docx["content_ref"]  # names the upstream version, for the update check
    assert ("anthropic", "docx") not in registry.store.manifests
    assert not any("skills/docx/" in url for url in gh.calls if "raw.githubusercontent" in url)
    assert registry.store.catalogue[("anthropic", "other")]["refusal"] is None


@pytest.mark.asyncio
async def test_a_row_admitted_before_the_platform_shipped_it_is_refused_on_the_next_pass(registry):
    _admitted_row(registry, "pdf")
    await registry.sync.reconcile_platform_skills(registry.store)
    assert registry.store.catalogue[("anthropic", "pdf")]["refusal"] == registry.platform.PLATFORM_REFUSAL
    assert ("anthropic", "pdf") not in registry.store.manifests


@pytest.mark.asyncio
async def test_turning_the_tier_off_makes_the_source_sync_its_copy_again(registry, agents_service, monkeypatch):
    _admitted_row(registry, "pdf")
    await registry.sync.reconcile_platform_skills(registry.store)
    settings = importlib.import_module("core.settings").settings
    monkeypatch.setattr(settings.filesystem, "platform_skills_enabled", False)
    await registry.sync.reconcile_platform_skills(registry.store)
    assert registry.store.sources["anthropic"]["source_ref"] is None


@pytest.mark.asyncio
@pytest.mark.parametrize(("content_ref", "warned"), [("newer-upstream", True), (PINNED["docx"], False)])
async def test_a_newer_upstream_version_is_reported_not_written(registry, monkeypatch, content_ref, warned):
    _admitted_row(registry, "docx", content_ref=content_ref)
    events: list[tuple[str, dict]] = []

    class _Logger:
        def warning(self, event, _message, **fields):
            events.append((event, fields))

    monkeypatch.setattr(registry.sync, "logger", _Logger())
    await registry.sync.reconcile_platform_skills(registry.store)
    updates = [fields for event, fields in events if event == "platform_skill_update_available"]
    assert bool(updates) is warned
    if warned:
        assert updates[0]["skill"] == "docx" and updates[0]["upstream_commit"] == SHA_A
