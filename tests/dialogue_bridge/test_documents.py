"""Canvas documents — the bridge's half (plan 44, Phase 4.1).

The agents service owns the versions; the bridge passes them through to the
conversation's owner. Only the agents service is faked (an ``httpx``
transport); the database, the owner check and the finalize path are real.
Pinned:

* someone else's conversation, or a trial, is a 404 with no upstream call;
* the four reads and the save pass through with the internal credential, the
  path as a query/body field, and the bodies re-validated (malformed → 502);
* the save's 409 passes through with the latest version and its text; an
  upstream 404 / 422 stays a 404 / 422; the save needs the CSRF token;
* at finalize the capture is called for presented ``.md`` files under
  output/ only — and, once the conversation has a document, after every run
  (4.3: an unpresented edit is captured too) — and its failure never fails
  the run;
* a presented file's attachment records ``source_path`` (and a fork keeps it).
"""
from __future__ import annotations

import base64
import json

import httpx
import pytest
from sqlalchemy import select
from sqlalchemy.orm import selectinload

import engine.inference.runs as ir
import engine.inference.output_capture as oc
from core.auth.session import require_csrf_protection
from core.database import AttachmentTable, ConversationTable, MessageTable
from core.settings import settings
from schema import AttachmentOut
from engine.conversations.conversations import clone_branch_to_conversation
from engine.inference.runs import InferenceRunRuntime

BRIEF = "/conversation/output/brief.md"
WHEN = "2026-11-18T10:00:00+00:00"
VERSION = {"path": BRIEF, "name": "brief.md", "version": 2, "author": "user", "base_version": 1,
           "created_at": WHEN, "size_bytes": 5, "content": "# Hi!"}


def _upstream(user_id: str, conversation_id: str, suffix: str = "") -> str:
    return f"/users/{user_id}/conversations/{conversation_id}/documents{suffix}"


def _route(user_id: str, conversation_id: str, suffix: str = "") -> str:
    return f"/v1/conversations/{user_id}/{conversation_id}/documents{suffix}"


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
@pytest.mark.parametrize("suffix", ["", "/latest", "/versions", "/versions/1"])
async def test_someone_elses_conversation_is_a_404_without_an_upstream_call(
    client, agents_service, session_factory, seeded_user, seeded_agent, suffix
):
    other = await _conversation(session_factory, "someone-else", seeded_agent)

    resp = await client.get(_route(seeded_user.id, other, suffix), params={"path": BRIEF})
    save = await client.post(_route(seeded_user.id, other, "/versions"),
                             json={"path": BRIEF, "base_version": 1, "content": "x"})

    assert resp.status_code == 404 and save.status_code == 404
    assert agents_service.calls == []


async def test_a_trial_conversation_is_a_404(client, agents_service, session_factory, seeded_user, seeded_agent):
    trial = await _conversation(session_factory, seeded_user.id, seeded_agent, is_trial=True)

    resp = await client.get(_route(seeded_user.id, trial, "/latest"), params={"path": BRIEF})

    assert resp.status_code == 404
    assert agents_service.calls == []


# ---------------------------------------------------------------------------
# Pass-through
# ---------------------------------------------------------------------------
async def test_the_reads_pass_through(client, agents_service, seeded_user, conv):
    uid = seeded_user.id
    summary = {"path": BRIEF, "name": "brief.md", "version": 2, "author": "user", "updated_at": WHEN,
               "size_bytes": 5, "extra": "dropped"}
    history = {"path": BRIEF, "versions": [
        {"version": 2, "author": "user", "base_version": 1, "created_at": WHEN, "size_bytes": 5},
        {"version": 1, "author": "agent", "base_version": None, "created_at": WHEN, "size_bytes": 4},
    ]}
    agents_service.on("GET", _upstream(uid, conv), httpx.Response(200, json={"documents": [summary]}))
    agents_service.on("GET", _upstream(uid, conv, "/latest"), httpx.Response(200, json=VERSION))
    agents_service.on("GET", _upstream(uid, conv, "/versions"), httpx.Response(200, json=history))
    agents_service.on("GET", _upstream(uid, conv, "/versions/2"), httpx.Response(200, json=VERSION))

    listing = await client.get(_route(uid, conv))
    latest = await client.get(_route(uid, conv, "/latest"), params={"path": BRIEF})
    versions = await client.get(_route(uid, conv, "/versions"), params={"path": BRIEF, "limit": 5})
    one = await client.get(_route(uid, conv, "/versions/2"), params={"path": BRIEF})

    assert listing.json() == {"documents": [{"path": BRIEF, "name": "brief.md", "version": 2, "author": "user",
                                             "updated_at": "2026-11-18T10:00:00Z", "size_bytes": 5}]}
    assert latest.json() == {**VERSION, "created_at": "2026-11-18T10:00:00Z"}
    assert [v["version"] for v in versions.json()["versions"]] == [2, 1]
    assert one.json()["content"] == "# Hi!"
    [latest_call] = agents_service.called("GET", _upstream(uid, conv, "/latest"))
    assert latest_call.url.params["path"] == BRIEF
    assert latest_call.headers.get(settings.proxy.header_name)
    [versions_call] = agents_service.called("GET", _upstream(uid, conv, "/versions"))
    assert versions_call.url.params["limit"] == "5"


async def test_a_save_passes_through_as_201(client, agents_service, seeded_user, conv):
    uid = seeded_user.id
    agents_service.on("POST", _upstream(uid, conv, "/versions"),
                      httpx.Response(201, json={"path": BRIEF, "version": 3, "created_at": WHEN}))

    resp = await client.post(_route(uid, conv, "/versions"),
                             json={"path": BRIEF, "base_version": 2, "content": "edited"})

    assert resp.status_code == 201
    assert resp.json() == {"path": BRIEF, "version": 3, "created_at": "2026-11-18T10:00:00Z"}
    [call] = agents_service.called("POST", _upstream(uid, conv, "/versions"))
    assert json.loads(call.content) == {"path": BRIEF, "base_version": 2, "content": "edited"}
    assert call.headers.get(settings.proxy.header_name)


async def test_a_stale_base_409_passes_through_with_the_latest_text(client, agents_service, seeded_user, conv):
    uid = seeded_user.id
    detail = {"code": "stale_base", "message": "The document has a newer version.",
              "current_version": 3, "current_content": "their text"}
    agents_service.on("POST", _upstream(uid, conv, "/versions"), httpx.Response(409, json={"detail": detail}))

    resp = await client.post(_route(uid, conv, "/versions"),
                             json={"path": BRIEF, "base_version": 2, "content": "mine"})

    assert resp.status_code == 409
    assert resp.json() == {"detail": detail}


@pytest.mark.parametrize("reply, expected", [
    (httpx.Response(404, json={"detail": "No such document."}), 404),
    (httpx.Response(422, json={"detail": "not a document"}), 422),
    (httpx.Response(409, json={"detail": "not the stale-base shape"}), 502),
    (httpx.Response(500), 502),
    (httpx.Response(201, json={"path": BRIEF}), 502),
])
async def test_upstream_errors_and_malformed_bodies(client, agents_service, seeded_user, conv, reply, expected):
    uid = seeded_user.id
    agents_service.on("POST", _upstream(uid, conv, "/versions"), reply)

    resp = await client.post(_route(uid, conv, "/versions"),
                             json={"path": BRIEF, "base_version": 1, "content": "x"})

    assert resp.status_code == expected


async def test_an_unreachable_agents_service_is_a_503(client, agents_service, seeded_user, conv):
    def down(request):
        raise httpx.ConnectError("agents down", request=request)

    agents_service.on("GET", _upstream(seeded_user.id, conv, "/latest"), down)

    resp = await client.get(_route(seeded_user.id, conv, "/latest"), params={"path": BRIEF})

    assert resp.status_code == 503


async def test_a_bad_request_never_goes_upstream(client, agents_service, seeded_user, conv):
    no_path = await client.get(_route(seeded_user.id, conv, "/latest"))
    bad_base = await client.post(_route(seeded_user.id, conv, "/versions"),
                                 json={"path": BRIEF, "base_version": 0, "content": "x"})
    extra = await client.post(_route(seeded_user.id, conv, "/versions"),
                              json={"path": BRIEF, "base_version": 1, "content": "x", "author": "agent"})

    assert (no_path.status_code, bad_base.status_code, extra.status_code) == (422, 422, 422)
    assert agents_service.calls == []


async def test_a_save_needs_the_csrf_token(app, client, agents_service, seeded_user, conv):
    app.dependency_overrides.pop(require_csrf_protection)

    resp = await client.post(_route(seeded_user.id, conv, "/versions"),
                             json={"path": BRIEF, "base_version": 1, "content": "x"})

    assert resp.status_code == 403
    assert agents_service.calls == []


# ---------------------------------------------------------------------------
# Finalize: capture + source_path
# ---------------------------------------------------------------------------
class _Files:
    """The agents service's presented-file read, as output_capture sees it."""

    def __init__(self, files: dict[str, bytes]):
        self.files = files

    async def fetch(self, url, paths):
        return [{"path": p, "filename": p.rsplit("/", 1)[-1], "mime": "text/markdown", "size": len(self.files[p]),
                 "base64": base64.b64encode(self.files[p]).decode()} for p in paths if p in self.files]


@pytest.fixture
def finalize(monkeypatch, session_factory, agents_service):
    """The real finalize on the test database, with the presented-file read faked."""
    monkeypatch.setattr(ir, "SessionLocal", session_factory)
    files = _Files({BRIEF: b"# Brief", "/conversation/output/chart.png": b"png",
                    "/conversation/output/notes/plan.md": b"plan"})
    monkeypatch.setattr(oc, "fetch_output_files", files.fetch)
    return agents_service


async def _run(session_factory, conversation_id):
    async with session_factory() as s:
        run = MessageTable(conversation_id=conversation_id, sender="ai", content="", streaming_status="running",
                           streaming_started_at=ir._now())
        s.add(run)
        await s.commit()
        return run.id


def _presented(*paths):
    runtime = InferenceRunRuntime()
    runtime.presented_artifacts = [{"artifact_id": f"a{i}", "path": p, "title": "T", "summary": None}
                                   for i, p in enumerate(paths)]
    return runtime


async def test_the_capture_gets_the_presented_markdown_only(finalize, session_factory, seeded_user, conv):
    run_id = await _run(session_factory, conv)
    capture = _upstream(seeded_user.id, conv, "/capture")
    finalize.on("POST", capture, httpx.Response(200, json={"captured": [
        {"path": BRIEF, "version": 1, "created": True}]}))

    await ir._mark_run_completed(run_id, _presented(BRIEF, "/conversation/output/chart.png",
                                                    "/conversation/output/notes/plan.md"))

    [call] = finalize.called("POST", capture)
    assert json.loads(call.content) == {"paths": [BRIEF, "/conversation/output/notes/plan.md"],
                                        "source_run_id": run_id}
    assert call.headers.get(settings.proxy.header_name)


async def test_no_markdown_presented_means_no_capture_call(finalize, session_factory, seeded_user, conv):
    run_id = await _run(session_factory, conv)

    await ir._mark_run_completed(run_id, _presented("/conversation/output/chart.png"))

    assert finalize.calls == []


async def test_a_conversation_with_a_document_is_captured_after_every_run(
    finalize, session_factory, seeded_user, conv
):
    # Plan 44 4.3: an Ask agent edit is an edit_file, not a new presentation,
    # so a run that presents nothing still asks the agents service to record
    # the documents it changed and to mark them seen.
    first = await _run(session_factory, conv)
    capture = _upstream(seeded_user.id, conv, "/capture")
    finalize.on("POST", capture, httpx.Response(200, json={"captured": []}))
    await ir._mark_run_completed(first, _presented(BRIEF))

    second = await _run(session_factory, conv)
    await ir._mark_run_completed(second, _presented())

    calls = finalize.called("POST", capture)
    assert [json.loads(c.content) for c in calls] == [
        {"paths": [BRIEF], "source_run_id": first},
        {"paths": [], "source_run_id": second},
    ]


@pytest.mark.parametrize("reply", [httpx.Response(503), httpx.Response(200, content=b"not json")])
async def test_a_failed_capture_never_fails_the_run(finalize, session_factory, seeded_user, conv, reply):
    run_id = await _run(session_factory, conv)
    finalize.on("POST", _upstream(seeded_user.id, conv, "/capture"), reply)

    await ir._mark_run_completed(run_id, _presented(BRIEF))

    async with session_factory() as s:
        run = await s.get(MessageTable, run_id)
        stored = (await s.execute(select(AttachmentTable).where(AttachmentTable.message_id == run_id))).scalars().all()
    assert run.streaming_status == "completed"
    assert [a.file_name for a in stored] == ["brief.md"]


async def test_an_unreachable_agents_service_never_fails_the_run(finalize, session_factory, seeded_user, conv):
    run_id = await _run(session_factory, conv)

    def down(request):
        raise httpx.ConnectError("agents down", request=request)

    finalize.on("POST", _upstream(seeded_user.id, conv, "/capture"), down)

    await ir._mark_run_completed(run_id, _presented(BRIEF))

    async with session_factory() as s:
        assert (await s.get(MessageTable, run_id)).streaming_status == "completed"


async def test_the_presented_path_is_stored_exposed_and_forked(finalize, session_factory, seeded_user, seeded_agent,
                                                               conv):
    run_id = await _run(session_factory, conv)
    finalize.on("POST", _upstream(seeded_user.id, conv, "/capture"), httpx.Response(200, json={"captured": []}))

    await ir._mark_run_completed(run_id, _presented("/conversation/output/notes/plan.md",
                                                    "/conversation/output/chart.png"))

    async with session_factory() as s:
        rows = (await s.execute(select(AttachmentTable).where(AttachmentTable.message_id == run_id)
                                .options(selectinload(AttachmentTable.blob)))).scalars().all()
        by_name = {a.file_name: a for a in rows}
        assert by_name["plan.md"].source_path == "/conversation/output/notes/plan.md"
        assert by_name["chart.png"].source_path == "/conversation/output/chart.png"
        assert AttachmentOut.model_validate(by_name["plan.md"]).model_dump()["source_path"] == (
            "/conversation/output/notes/plan.md"
        )
        source = (await s.execute(
            select(ConversationTable).where(ConversationTable.id == conv)
            .options(selectinload(ConversationTable.messages).selectinload(MessageTable.attachments)
                     .selectinload(AttachmentTable.blob))
        )).scalar_one()
        run = next(m for m in source.messages if m.id == run_id)
        fork = await clone_branch_to_conversation(db=s, source_conv=source, branch=[run],
                                                  forked_message_id=run.id)
        await s.commit()
        fork_id = fork.id
    async with session_factory() as s:
        copied = (await s.execute(
            select(AttachmentTable).join(MessageTable).where(MessageTable.conversation_id == fork_id)
        )).scalars().all()
    assert sorted(a.source_path for a in copied) == [
        "/conversation/output/chart.png", "/conversation/output/notes/plan.md",
    ]


async def test_an_upload_has_no_source_path(session_factory, conv):
    async with session_factory() as s:
        message = MessageTable(conversation_id=conv, sender="user", content="hi")
        s.add(message)
        await s.flush()
        upload = AttachmentTable(message_id=message.id, file_name="a.txt", mime_type="text/plain")
        s.add(upload)
        await s.commit()
        upload = (await s.execute(select(AttachmentTable).where(AttachmentTable.id == upload.id)
                                  .options(selectinload(AttachmentTable.blob)))).scalar_one()
        assert AttachmentOut.model_validate(upload).model_dump()["source_path"] is None
