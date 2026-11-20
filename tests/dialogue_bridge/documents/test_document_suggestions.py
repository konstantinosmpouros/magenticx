"""Canvas suggestions — the bridge's half (plan 44, Phase 4.6, Suggesting mode).

The agents service owns the pending suggestion sets; the bridge passes them
through to the conversation's owner. Only the agents service is faked (an
``httpx`` transport); the database and the owner check are real. Pinned:

* someone else's conversation, or a trial, is a 404 with no upstream call;
* GET / PUT / DELETE pass through with the internal credential, camelCase in
  and out, snake_case upstream, every body re-validated;
* the GET's 404 ``no_suggestion`` passes through; any other 404 is generic;
* the PUT's 204 (the proposed text equals the base) stays a 204;
* a bad body (unknown field, snake_case, bounds) never goes upstream;
* a 422 upstream is a generic 422; a malformed body or a 500 is a 502;
  unreachable is a 503;
* the writes need the CSRF token and have their own rate-limit bucket.
"""
from __future__ import annotations

import json

import httpx
import pytest

from core.auth.session import require_csrf_protection
from core.database import ConversationTable
from core.security import rate_limit
from core.settings import settings

BRIEF = "/conversation/output/brief.md"
WHEN = "2026-11-19T10:00:00+00:00"
UPSTREAM_SET = {"path": BRIEF, "base_version": 3, "content": "# Brief\n\nProposed.", "updated_at": WHEN}
BROWSER_SET = {"path": BRIEF, "baseVersion": 3, "content": "# Brief\n\nProposed.",
               "updatedAt": "2026-11-19T10:00:00Z"}


def _upstream(user_id: str, conversation_id: str) -> str:
    return f"/users/{user_id}/conversations/{conversation_id}/documents/suggestion"


def _route(user_id: str, conversation_id: str) -> str:
    return f"/v1/conversations/{user_id}/{conversation_id}/documents/suggestion"


def _body(**overrides):
    return {"path": BRIEF, "baseVersion": 3, "content": "# Brief\n\nProposed.", **overrides}


async def _conversation(session_factory, user_id: str, agent, *, is_trial: bool = False) -> str:
    async with session_factory() as s:
        conv = ConversationTable(user_id=user_id, agent_id=agent.id, agent_name=agent.name, title="t",
                                 is_trial=is_trial, is_private=is_trial)
        s.add(conv)
        await s.commit()
        return conv.id


@pytest.fixture
async def conv(session_factory, seeded_user, seeded_agent):
    return await _conversation(session_factory, seeded_user.id, seeded_agent)


# ---------------------------------------------------------------------------
# Owner check
# ---------------------------------------------------------------------------
async def test_someone_elses_conversation_is_a_404_without_an_upstream_call(
    client, agents_service, session_factory, seeded_user, seeded_agent
):
    other = await _conversation(session_factory, "someone-else", seeded_agent)
    trial = await _conversation(session_factory, seeded_user.id, seeded_agent, is_trial=True)
    uid = seeded_user.id

    responses = [
        await client.get(_route(uid, other), params={"path": BRIEF}),
        await client.put(_route(uid, other), json=_body()),
        await client.delete(_route(uid, other), params={"path": BRIEF}),
        await client.get(_route(uid, trial), params={"path": BRIEF}),
    ]

    assert [r.status_code for r in responses] == [404, 404, 404, 404]
    assert agents_service.calls == []


# ---------------------------------------------------------------------------
# Pass-through
# ---------------------------------------------------------------------------
async def test_get_passes_through_in_camel_case(client, agents_service, seeded_user, conv):
    uid = seeded_user.id
    agents_service.on("GET", _upstream(uid, conv), httpx.Response(200, json={**UPSTREAM_SET, "extra": "dropped"}))

    resp = await client.get(_route(uid, conv), params={"path": BRIEF})

    assert resp.status_code == 200
    assert resp.json() == BROWSER_SET
    [call] = agents_service.called("GET", _upstream(uid, conv))
    assert call.url.params["path"] == BRIEF
    assert call.headers.get(settings.proxy.header_name)


async def test_no_suggestion_passes_through(client, agents_service, seeded_user, conv):
    uid = seeded_user.id
    agents_service.on("GET", _upstream(uid, conv), httpx.Response(
        404, json={"detail": {"code": "no_suggestion", "message": "The document has no pending suggestions."}}))

    resp = await client.get(_route(uid, conv), params={"path": BRIEF})

    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "no_suggestion"


async def test_put_goes_upstream_in_snake_case(client, agents_service, seeded_user, conv):
    uid = seeded_user.id
    agents_service.on("PUT", _upstream(uid, conv), httpx.Response(200, json=UPSTREAM_SET))

    resp = await client.put(_route(uid, conv), json=_body())

    assert resp.status_code == 200
    assert resp.json() == BROWSER_SET
    [call] = agents_service.called("PUT", _upstream(uid, conv))
    assert json.loads(call.content) == {"path": BRIEF, "base_version": 3, "content": "# Brief\n\nProposed."}
    assert call.headers.get(settings.proxy.header_name)


async def test_a_cleared_set_is_a_204(client, agents_service, seeded_user, conv):
    uid = seeded_user.id
    agents_service.on("PUT", _upstream(uid, conv), httpx.Response(204))

    resp = await client.put(_route(uid, conv), json=_body())

    assert resp.status_code == 204 and resp.content == b""


async def test_delete_passes_through(client, agents_service, seeded_user, conv):
    uid = seeded_user.id
    agents_service.on("DELETE", _upstream(uid, conv), httpx.Response(204))

    resp = await client.delete(_route(uid, conv), params={"path": BRIEF})

    assert resp.status_code == 204 and resp.content == b""
    [call] = agents_service.called("DELETE", _upstream(uid, conv))
    assert call.url.params["path"] == BRIEF


@pytest.mark.parametrize("body", [
    _body(baseVersion=0),
    _body(path=""),
    _body(path="p" * 1025),
    _body(content="c" * (1024 * 1024 + 1)),
    _body(author="agent"),  # unknown field
    {"path": BRIEF, "base_version": 3, "content": "x"},  # snake_case is not the browser's contract
    {"path": BRIEF, "baseVersion": 3},  # no content
])
async def test_a_bad_body_never_goes_upstream(client, agents_service, seeded_user, conv, body):
    resp = await client.put(_route(seeded_user.id, conv), json=body)

    assert resp.status_code == 422
    assert agents_service.calls == []


async def test_a_read_or_delete_needs_a_path(client, agents_service, seeded_user, conv):
    uid = seeded_user.id
    responses = [await client.get(_route(uid, conv)), await client.delete(_route(uid, conv))]

    assert [r.status_code for r in responses] == [422, 422]
    assert agents_service.calls == []


@pytest.mark.parametrize("reply, expected_status, expected_detail", [
    (httpx.Response(404, json={"detail": "No such document version."}), 404, "Document not found."),
    (httpx.Response(422, json={"detail": "The suggested text is over 1 MiB."}), 422,
     "Those suggestions cannot be saved on this document."),
    (httpx.Response(500), 502, None),
    (httpx.Response(200, json={"path": BRIEF, "base_version": 0, "content": "x", "updated_at": WHEN}), 502, None),
    (httpx.Response(200, json={"path": BRIEF}), 502, None),
])
async def test_upstream_errors_and_malformed_bodies(
    client, agents_service, seeded_user, conv, reply, expected_status, expected_detail
):
    uid = seeded_user.id
    agents_service.on("PUT", _upstream(uid, conv), reply)

    resp = await client.put(_route(uid, conv), json=_body())

    assert resp.status_code == expected_status
    if expected_detail is not None:
        assert resp.json()["detail"] == expected_detail


async def test_an_unreachable_agents_service_is_a_503(client, agents_service, seeded_user, conv):
    def down(request):
        raise httpx.ConnectError("agents down", request=request)

    agents_service.on("GET", _upstream(seeded_user.id, conv), down)

    resp = await client.get(_route(seeded_user.id, conv), params={"path": BRIEF})

    assert resp.status_code == 503


async def test_every_write_needs_the_csrf_token(app, client, agents_service, seeded_user, conv):
    app.dependency_overrides.pop(require_csrf_protection)
    uid = seeded_user.id

    responses = [
        await client.put(_route(uid, conv), json=_body()),
        await client.delete(_route(uid, conv), params={"path": BRIEF}),
    ]

    assert [r.status_code for r in responses] == [403, 403]
    assert agents_service.calls == []


def test_the_suggestion_bucket_defaults_to_sixty_writes_a_minute():
    fields = type(settings.rate_limit).model_fields
    assert fields["document_suggestion_max_attempts"].default == 60
    assert fields["document_suggestion_window_seconds"].default == 60
    assert rate_limit.document_suggestion_rate_limit is not rate_limit.document_save_rate_limit


def test_the_routes_use_the_suggestion_bucket_for_writes_and_the_read_bucket_for_reads(app):
    def deps(method: str):
        path = "/v1/conversations/{user_id}/{conversation_id}/documents/suggestion"
        [route] = [r for r in app.routes if getattr(r, "path", None) == path and method in getattr(r, "methods", ())]
        return {d.call for d in route.dependant.dependencies}

    assert rate_limit.document_read_rate_limit in deps("GET")
    for method in ("PUT", "DELETE"):
        assert rate_limit.document_suggestion_rate_limit in deps(method)
        assert require_csrf_protection in deps(method)
