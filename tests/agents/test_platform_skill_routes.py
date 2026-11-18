"""The platform skills' read-only routes (plan 44): what the Skills tab shows.

Pinned here:

* ``GET /skills/platform`` lists the four shipped document skills with the
  front-matter description, the licence their LICENSE.txt carries, the repo and
  commit ``SOURCE`` pins, a link to the folder upstream and a file count;
* it is empty when the tier is off (setting or folder), never an error;
* ``GET /skills/platform/{name}`` returns the full SKILL.md text, 404s an
  unknown name, refuses a malformed one, and never reads outside the folder;
* a SKILL.md the agent would skip is not listed;
* both routes are internal.
"""
from __future__ import annotations

import importlib

import pytest

COMMIT = "e4bb5d960d87126ff3b3a8af1a104b7db67560ba"


@pytest.fixture()
def settings(agents_service):
    return importlib.import_module("core.settings").settings


def _skill(root, name: str, *, description: str = "Does things", licence: str | None = "Apache License\nVersion 2.0, January 2004\n") -> None:
    folder = root / name
    (folder / "scripts").mkdir(parents=True)
    (folder / "SKILL.md").write_text(
        f"---\nname: {name}\ndescription: {description}\nlicense: Complete terms in LICENSE.txt\n---\n\n# {name}\n",
        encoding="utf-8",
    )
    if licence is not None:
        (folder / "LICENSE.txt").write_text(licence, encoding="utf-8")
    (folder / "scripts" / "run.py").write_text("print(1)\n", encoding="utf-8")
    (folder / "scripts" / "__pycache__").mkdir()
    (folder / "scripts" / "__pycache__" / "run.cpython-312.pyc").write_bytes(b"\0")


@pytest.fixture()
def platform_root(settings, monkeypatch, tmp_path):
    root = tmp_path / "platform_skills"
    root.mkdir()
    (root / "SOURCE").write_text(f"repo https://github.com/anthropics/skills\ncommit {COMMIT}\n", encoding="utf-8")
    monkeypatch.setattr(settings.filesystem, "platform_skills_root", root)
    monkeypatch.setattr(settings.filesystem, "platform_skills_enabled", True)
    return root


async def test_lists_the_shipped_document_skills(client, internal_headers):
    response = await client.get("/skills/platform", headers=internal_headers)
    assert response.status_code == 200
    rows = response.json()
    assert [row["name"] for row in rows] == ["docx", "pdf", "pptx", "xlsx"]
    for row in rows:
        assert row["description"]
        assert row["licence"] == "Apache-2.0"
        assert row["source_label"] == "anthropics/skills"
        assert row["source_repo"] == "https://github.com/anthropics/skills"
        assert len(row["source_commit"]) == 40
        assert row["upstream_url"] == f"https://github.com/anthropics/skills/tree/{row['source_commit']}/skills/{row['name']}"
        assert row["file_count"] >= 3  # SKILL.md, LICENSE.txt, CHANGES.md at least
        assert "content" not in row


async def test_a_row_carries_the_front_matter_and_counts_real_files_only(client, internal_headers, platform_root):
    _skill(platform_root, "docx", description="Word files")
    rows = (await client.get("/skills/platform", headers=internal_headers)).json()
    assert rows == [{
        "name": "docx", "description": "Word files", "licence": "Apache-2.0",
        "source_label": "anthropics/skills", "source_repo": "https://github.com/anthropics/skills",
        "source_commit": COMMIT, "upstream_url": f"https://github.com/anthropics/skills/tree/{COMMIT}/skills/docx",
        "file_count": 3,  # SKILL.md, LICENSE.txt, scripts/run.py — not the .pyc
    }]


async def test_an_unrecognised_licence_reads_as_none(client, internal_headers, platform_root):
    _skill(platform_root, "docx", licence=None)
    _skill(platform_root, "pdf", licence="Some bespoke terms.")
    rows = (await client.get("/skills/platform", headers=internal_headers)).json()
    assert [row["licence"] for row in rows] == [None, None]


async def test_a_skill_md_the_agent_would_skip_is_not_listed(client, internal_headers, platform_root):
    _skill(platform_root, "docx")
    broken = platform_root / "pdf"
    broken.mkdir()
    (broken / "SKILL.md").write_text("no front matter here\n", encoding="utf-8")
    rows = (await client.get("/skills/platform", headers=internal_headers)).json()
    assert [row["name"] for row in rows] == ["docx"]
    assert (await client.get("/skills/platform/pdf", headers=internal_headers)).status_code == 404


@pytest.mark.parametrize("off", ["setting", "folder"])
async def test_the_list_is_empty_when_the_tier_is_off(client, internal_headers, settings, monkeypatch, tmp_path, off):
    if off == "setting":
        monkeypatch.setattr(settings.filesystem, "platform_skills_enabled", False)
    else:
        monkeypatch.setattr(settings.filesystem, "platform_skills_root", tmp_path / "missing")
    response = await client.get("/skills/platform", headers=internal_headers)
    assert response.status_code == 200 and response.json() == []
    assert (await client.get("/skills/platform/docx", headers=internal_headers)).status_code == 404


async def test_the_detail_returns_the_whole_skill_md(client, internal_headers):
    response = await client.get("/skills/platform/pdf", headers=internal_headers)
    assert response.status_code == 200
    body = response.json()
    assert body["name"] == "pdf" and body["licence"] == "Apache-2.0"
    assert body["content"].startswith("---\nname: pdf\n")
    assert "Platform notes (mAgenticX)" in body["content"]


async def test_the_detail_404s_an_unknown_skill_and_refuses_a_malformed_name(client, internal_headers):
    assert (await client.get("/skills/platform/odt", headers=internal_headers)).status_code == 404
    for bad in ("..%2FSOURCE", "PDF", "-pdf", "x" * 65):
        assert (await client.get(f"/skills/platform/{bad}", headers=internal_headers)).status_code in (404, 422), bad


async def test_the_detail_never_reads_outside_the_listed_skills(client, internal_headers, platform_root):
    _skill(platform_root, "docx")
    # A folder with a SKILL.md whose name does not match is not a listed skill.
    stray = platform_root / "other"
    stray.mkdir()
    (stray / "SKILL.md").write_text("---\nname: docx\ndescription: imposter\n---\n", encoding="utf-8")
    assert (await client.get("/skills/platform/other", headers=internal_headers)).status_code == 404
    rows = (await client.get("/skills/platform", headers=internal_headers)).json()
    assert [row["name"] for row in rows] == ["docx"]


async def test_platform_routes_require_internal_caller(client):
    assert (await client.get("/skills/platform")).status_code == 403
    assert (await client.get("/skills/platform/pdf")).status_code == 403
