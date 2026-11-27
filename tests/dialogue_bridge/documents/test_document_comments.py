"""Canvas comments — the bridge's half (plan 44, Phase 4.4).

The agents service owns the comments; the bridge passes them through to the
conversation's owner. Only the agents service is faked (an ``httpx``
transport); the database and the owner check are real. Pinned:

* someone else's conversation, or a trial, is a 404 with no upstream call;
* the list, add, patch and delete pass through with the internal credential,
  camelCase in and out, snake_case upstream, every body re-validated;
* a thread needs an anchor and no parentId, a reply the reverse — refused
  before any upstream call, like an empty patch or an unknown field;
* an upstream 404 stays a 404; a 422's known ``{code, message}`` passes
  through, any other 422 is a generic one; a malformed body is a 502;
* every write needs the CSRF token and has its own rate-limit bucket.
"""
from __future__ import annotations

import json
import uuid

import httpx
import pytest

from core.auth.session import require_csrf_protection
from core.database import ConversationTable
from core.security import rate_limit
from core.settings import settings
from engine.conversations.file_branches import FileBranch, document_branch

BRIEF = "/conversation/output/brief.md"
WHEN = "2026-11-19T10:00:00+00:00"
THREAD_ID = str(uuid.uuid4())
ANCHOR = {"quote": "the passage", "prefix": "text before", "suffix": "text after"}
UPSTREAM_THREAD = {
    "id": THREAD_ID, "path": BRIEF, "version": 4, "parent_id": None, "anchor": ANCHOR, "body": "Shorter here?",
    "author": "user", "status": "open", "resolved_by": None, "resolution_note": None,
    "created_at": WHEN, "updated_at": WHEN,
}
BROWSER_THREAD = {
    "id": THREAD_ID, "path": BRIEF, "version": 4, "parentId": None, "anchor": ANCHOR, "body": "Shorter here?",
    "author": "user", "status": "open", "resolvedBy": None, "resolutionNote": None,
    "createdAt": "2026-11-19T10:00:00Z", "updatedAt": "2026-11-19T10:00:00Z",
}


def _upstream(user_id: str, conversation_id: str, suffix: str = "") -> str:
    return f"/users/{user_id}/conversations/{conversation_id}/documents/comments{suffix}"


def _route(user_id: str, conversation_id: str, suffix: str = "") -> str:
    return f"/v1/conversations/{user_id}/{conversation_id}/documents/comments{suffix}"


async def _conversation(session_factory, user_id: str, agent, *, is_trial: bool = False) -> str:
    async with session_factory() as s:
        conv = ConversationTable(user_id=user_id, agent_id=agent.id, agent_name=agent.name, title="t",
                                 is_trial=is_trial, is_private=is_trial)
        s.add(conv)
        await s.commit()
        return conv.id



@pytest.fixture(autouse=True)
def _on_one_branch(request):
    """Document routes resolve the branch from a message of the conversation;
    these tests are about the pass-through, so the branch is given: one of
    its answers on thread b1."""
    if "app" in request.fixturenames or "client" in request.fixturenames:
        app = request.getfixturevalue("app")
        app.dependency_overrides[document_branch] = lambda: FileBranch(thread_id="b1", message_id="m1")

@pytest.fixture
async def conv(session_factory, seeded_user, seeded_agent):
    return await _conversation(session_factory, seeded_user.id, seeded_agent)


def _thread_body(**overrides):
    return {"path": BRIEF, "version": 4, "anchor": ANCHOR, "body": "Shorter here?", **overrides}


# ---------------------------------------------------------------------------
# Owner check
# ---------------------------------------------------------------------------
async def test_someone_elses_conversation_is_a_404_without_an_upstream_call(
    client, agents_service, session_factory, seeded_user, seeded_agent
):
    other = await _conversation(session_factory, "someone-else", seeded_agent)
    uid = seeded_user.id

    responses = [
        await client.get(_route(uid, other), params={"path": BRIEF}),
        await client.post(_route(uid, other), json=_thread_body()),
        await client.patch(_route(uid, other, f"/{THREAD_ID}"), json={"status": "resolved"}),
        await client.delete(_route(uid, other, f"/{THREAD_ID}")),
    ]

    assert [r.status_code for r in responses] == [404, 404, 404, 404]
    assert agents_service.calls == []


async def test_a_trial_conversation_is_a_404(client, agents_service, session_factory, seeded_user, seeded_agent):
    trial = await _conversation(session_factory, seeded_user.id, seeded_agent, is_trial=True)

    resp = await client.get(_route(seeded_user.id, trial), params={"path": BRIEF})

    assert resp.status_code == 404
    assert agents_service.calls == []


# ---------------------------------------------------------------------------
# Pass-through
# ---------------------------------------------------------------------------
async def test_the_list_passes_through_in_camel_case(client, agents_service, seeded_user, conv):
    uid = seeded_user.id
    reply = {**UPSTREAM_THREAD, "id": str(uuid.uuid4()), "parent_id": THREAD_ID, "anchor": None, "status": None,
             "body": "Agreed.", "extra": "dropped"}
    agents_service.on("GET", _upstream(uid, conv),
                      httpx.Response(200, json={"comments": [UPSTREAM_THREAD, reply]}))

    resp = await client.get(_route(uid, conv), params={"path": BRIEF})

    assert resp.status_code == 200
    first, second = resp.json()["comments"]
    assert first == BROWSER_THREAD
    assert (second["parentId"], second["anchor"], second["status"]) == (THREAD_ID, None, None)
    assert "extra" not in second
    [call] = agents_service.called("GET", _upstream(uid, conv))
    assert call.url.params["path"] == BRIEF
    assert call.headers.get(settings.proxy.header_name)


async def test_a_thread_and_a_reply_go_upstream_in_snake_case(client, agents_service, seeded_user, conv):
    uid = seeded_user.id
    agents_service.on("POST", _upstream(uid, conv), httpx.Response(201, json=UPSTREAM_THREAD))

    thread = await client.post(_route(uid, conv), json=_thread_body())
    reply = await client.post(_route(uid, conv),
                              json={"path": BRIEF, "version": 4, "body": "Agreed.", "parentId": THREAD_ID})

    assert (thread.status_code, reply.status_code) == (201, 201)
    assert thread.json() == BROWSER_THREAD
    first, second = agents_service.called("POST", _upstream(uid, conv))
    assert json.loads(first.content) == {"path": BRIEF, "version": 4, "anchor": ANCHOR, "body": "Shorter here?",
                                         "parent_id": None}
    assert json.loads(second.content) == {"path": BRIEF, "version": 4, "anchor": None, "body": "Agreed.",
                                          "parent_id": THREAD_ID}
    assert first.headers.get(settings.proxy.header_name)


async def test_patch_and_delete_pass_through(client, agents_service, seeded_user, conv):
    uid = seeded_user.id
    resolved = {**UPSTREAM_THREAD, "status": "resolved", "resolved_by": "user"}
    agents_service.on("PATCH", _upstream(uid, conv, f"/{THREAD_ID}"), httpx.Response(200, json=resolved))
    agents_service.on("DELETE", _upstream(uid, conv, f"/{THREAD_ID}"), httpx.Response(204))

    patched = await client.patch(_route(uid, conv, f"/{THREAD_ID}"), json={"status": "resolved"})
    deleted = await client.delete(_route(uid, conv, f"/{THREAD_ID}"))

    assert patched.status_code == 200
    assert (patched.json()["status"], patched.json()["resolvedBy"]) == ("resolved", "user")
    [call] = agents_service.called("PATCH", _upstream(uid, conv, f"/{THREAD_ID}"))
    assert json.loads(call.content) == {"status": "resolved"}
    assert deleted.status_code == 204 and deleted.content == b""


@pytest.mark.parametrize("body", [
    _thread_body(anchor=None),  # a thread without an anchor
    _thread_body(parentId=THREAD_ID),  # a reply with an anchor
    _thread_body(body=""),
    _thread_body(body="b" * 4001),
    _thread_body(anchor={"quote": "q" * 2001}),
    _thread_body(anchor={"quote": "q", "prefix": "p" * 201}),
    _thread_body(version=0),
    _thread_body(author="agent"),  # unknown field
    _thread_body(parent_id=THREAD_ID, anchor=None),  # snake_case is not the browser's contract
])
async def test_a_bad_comment_never_goes_upstream(client, agents_service, seeded_user, conv, body):
    resp = await client.post(_route(seeded_user.id, conv), json=body)

    assert resp.status_code == 422
    assert agents_service.calls == []


async def test_a_bad_patch_or_id_never_goes_upstream(client, agents_service, seeded_user, conv):
    uid = seeded_user.id
    empty = await client.patch(_route(uid, conv, f"/{THREAD_ID}"), json={})
    status = await client.patch(_route(uid, conv, f"/{THREAD_ID}"), json={"status": "closed"})
    bad_id = await client.patch(_route(uid, conv, "/not-a-uuid"), json={"status": "open"})
    no_path = await client.get(_route(uid, conv))

    assert [r.status_code for r in (empty, status, bad_id, no_path)] == [422, 422, 422, 422]
    assert agents_service.calls == []


@pytest.mark.parametrize("reply, expected_status, expected_detail", [
    (httpx.Response(404, json={"detail": "No such document or comment."}), 404,
     "That document or comment is not in this conversation."),
    (httpx.Response(422, json={"detail": {"code": "thread_limit", "message": "At most 200."}}), 422,
     {"code": "thread_limit", "message": "At most 200."}),
    (httpx.Response(422, json={"detail": [{"loc": ["body"], "msg": "x"}]}), 422, "That comment cannot be saved."),
    (httpx.Response(500), 502, None),
    (httpx.Response(201, json={"id": "not-a-uuid"}), 502, None),
])
async def test_upstream_errors_and_malformed_bodies(
    client, agents_service, seeded_user, conv, reply, expected_status, expected_detail
):
    uid = seeded_user.id
    agents_service.on("POST", _upstream(uid, conv), reply)

    resp = await client.post(_route(uid, conv), json=_thread_body())

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
        await client.post(_route(uid, conv), json=_thread_body()),
        await client.patch(_route(uid, conv, f"/{THREAD_ID}"), json={"status": "resolved"}),
        await client.delete(_route(uid, conv, f"/{THREAD_ID}")),
    ]

    assert [r.status_code for r in responses] == [403, 403, 403]
    assert agents_service.calls == []


def test_the_comment_bucket_defaults_to_sixty_writes_a_minute():
    fields = type(settings.rate_limit).model_fields
    assert fields["document_comment_max_attempts"].default == 60
    assert fields["document_comment_window_seconds"].default == 60
    assert rate_limit.document_comment_rate_limit is not rate_limit.document_save_rate_limit


def test_the_comment_routes_use_the_comment_bucket_for_writes_and_the_read_bucket_for_reads(app):
    def deps(path: str, method: str):
        [route] = [r for r in app.routes if getattr(r, "path", None) == path and method in getattr(r, "methods", ())]
        return {d.call for d in route.dependant.dependencies}

    base = "/v1/conversations/{user_id}/{conversation_id}/documents/comments"
    assert rate_limit.document_read_rate_limit in deps(base, "GET")
    for path, method in ((base, "POST"), (f"{base}/{{comment_id}}", "PATCH"), (f"{base}/{{comment_id}}", "DELETE")):
        assert rate_limit.document_comment_rate_limit in deps(path, method)
        assert require_csrf_protection in deps(path, method)
