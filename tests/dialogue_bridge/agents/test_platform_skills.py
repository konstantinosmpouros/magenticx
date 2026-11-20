"""The bridge's platform-skills reads (plan 44): ``GET /v1/skills/platform[/{name}]``.

Pinned here:

* both routes need a session and nothing else (no user id: the list is the same
  for everyone), and a malformed name is refused before anything is forwarded;
* each is one uncached GET to the agents service with the internal headers;
* the payload is validated into the public contract (unknown fields dropped);
* an upstream 404 stays a 404, any other failure is a reviewed 502/503.
"""
from __future__ import annotations

import httpx
import pytest
from test_skills import FakeResponse, install_fake_client

import engine.agents.skills as skills_mod
from core.auth.session import require_current_user
from engine.agents.skills import get_platform_skill_detail, list_platform_skills

ROW = {
    "name": "pdf",
    "description": "Work with PDF files.",
    "licence": "Apache-2.0",
    "source_label": "anthropics/skills",
    "source_repo": "https://github.com/anthropics/skills",
    "source_commit": "e4bb5d960d87126ff3b3a8af1a104b7db67560ba",
    "upstream_url": "https://github.com/anthropics/skills/tree/e4bb5d9/skills/pdf",
    "file_count": 12,
}


@pytest.fixture
def signed_in(app, seeded_user):
    async def override_current_user():
        return seeded_user

    app.dependency_overrides[require_current_user] = override_current_user
    yield
    app.dependency_overrides.pop(require_current_user, None)


# ---------------------------------------------------------------------------
# utils — the forwarding
# ---------------------------------------------------------------------------
async def test_the_list_is_one_uncached_get_with_internal_headers(monkeypatch):
    calls: list = []
    install_fake_client(monkeypatch, lambda m, u, k: FakeResponse(json_data=[ROW]), calls)
    assert await list_platform_skills() == [ROW]
    await list_platform_skills()
    assert len(calls) == 2
    method, url, kwargs = calls[0]
    assert method == "GET" and url.endswith("/skills/platform")
    assert kwargs["headers"]  # the internal-caller headers ride along


async def test_a_non_list_payload_reads_as_empty(monkeypatch):
    install_fake_client(monkeypatch, lambda m, u, k: FakeResponse(json_data={"oops": True}))
    assert await list_platform_skills() == []


async def test_the_detail_forwards_the_name(monkeypatch):
    calls: list = []
    detail = {**ROW, "content": "---\nname: pdf\n---\n"}
    install_fake_client(monkeypatch, lambda m, u, k: FakeResponse(json_data=detail), calls)
    assert await get_platform_skill_detail(skill_name="pdf") == detail
    assert calls[0][1].endswith("/skills/platform/pdf")


async def test_the_detail_maps_upstream_failures(monkeypatch):
    install_fake_client(monkeypatch, lambda m, u, k: FakeResponse(status_code=404))
    with pytest.raises(Exception) as exc:
        await get_platform_skill_detail(skill_name="odt")
    assert getattr(exc.value, "status_code", None) == 404

    install_fake_client(monkeypatch, lambda m, u, k: FakeResponse(json_data=["not", "a", "dict"]))
    with pytest.raises(Exception) as exc:
        await get_platform_skill_detail(skill_name="pdf")
    assert getattr(exc.value, "status_code", None) == 502

    install_fake_client(monkeypatch, lambda m, u, k: FakeResponse(status_code=500, raise_status=True))
    with pytest.raises(Exception) as exc:
        await list_platform_skills()
    assert getattr(exc.value, "status_code", None) == 502

    install_fake_client(
        monkeypatch,
        lambda m, u, k: httpx.ConnectError("down", request=httpx.Request("GET", "http://agents.test")),
    )
    with pytest.raises(Exception) as exc:
        await list_platform_skills()
    assert getattr(exc.value, "status_code", None) == 503


# ---------------------------------------------------------------------------
# routes — the HTTP edge
# ---------------------------------------------------------------------------
async def test_both_routes_require_a_session(client):
    assert (await client.get("/v1/skills/platform")).status_code in (401, 403)
    assert (await client.get("/v1/skills/platform/pdf")).status_code in (401, 403)


async def test_the_list_route_serves_the_public_contract(client, signed_in, monkeypatch):
    install_fake_client(monkeypatch, lambda m, u, k: FakeResponse(json_data=[{**ROW, "internal": "dropped"}]))
    response = await client.get("/v1/skills/platform")
    assert response.status_code == 200
    assert response.json() == [ROW]


async def test_the_detail_route_serves_the_skill_md(client, signed_in, monkeypatch):
    detail = {**ROW, "content": "---\nname: pdf\n---\nBody\n"}
    install_fake_client(monkeypatch, lambda m, u, k: FakeResponse(json_data=detail))
    response = await client.get("/v1/skills/platform/pdf")
    assert response.status_code == 200
    assert response.json() == detail


async def test_the_detail_route_refuses_a_malformed_name_without_forwarding(client, signed_in, monkeypatch):
    calls: list = []
    install_fake_client(monkeypatch, lambda m, u, k: FakeResponse(json_data={}), calls)
    for bad in ("PDF", "-pdf", "x" * 65, "pdf%2F..%2Fx"):
        assert (await client.get(f"/v1/skills/platform/{bad}")).status_code in (404, 422), bad
    assert calls == []


async def test_an_unknown_skill_is_a_404(client, signed_in, monkeypatch):
    install_fake_client(monkeypatch, lambda m, u, k: FakeResponse(status_code=404))
    assert (await client.get("/v1/skills/platform/odt")).status_code == 404


def test_the_routes_are_registered(app):
    paths = {getattr(r, "path", "") for r in app.routes}
    assert {"/v1/skills/platform", "/v1/skills/platform/{skill_name}"} <= paths
    assert skills_mod._AGENTS_PLATFORM_SKILLS_ENDPOINT.endswith("/skills/platform")
