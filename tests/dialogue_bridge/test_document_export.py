"""Canvas export and Office PDF previews — the bridge's half (plan 44, Phase 4.5).

Only the agents service is faked (an ``httpx`` transport); the database, the
owner checks and the preview cache are real. Pinned:

* export: someone else's conversation or a trial is a 404 with no upstream
  call; the file passes through with ``Content-Disposition: attachment`` and
  a ``filename*`` built from the upstream name — a name that is not a plain
  ``<title>.<fmt>`` falls back to ``document.<fmt>``; a wrong content type is
  never forwarded;
* the box's outcomes become structured bodies the UI reads: 503
  ``sandbox_unavailable``, 504 ``conversion_timeout``, 502
  ``conversion_failed``; 404 / 422 stay; an unreachable agents service is a 503;
* preview: owner-checked like the download (404, no upstream call), Office
  types only (415), size-capped (413); a render is cached by the source bytes'
  hash, so the second open — or the same bytes in another of the user's
  conversations — never reaches the agents service, while another user's
  identical file does; a failed or bogus render is not cached; deleting the
  attachment drops its preview.
"""
from __future__ import annotations

import hashlib
import json
from urllib.parse import quote

import httpx
import pytest
from sqlalchemy import func, select

import engine.documents.export as preview_utils
from core.database import (
    AttachmentPdfPreviewTable,
    AttachmentTable,
    BlobTable,
    ConversationTable,
    MessageTable,
)
from core.settings import settings

BRIEF = "/conversation/output/brief.md"
DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
PDF = b"%PDF-1.7 rendered"


def _route(user_id: str, conversation_id: str) -> str:
    return f"/v1/conversations/{user_id}/{conversation_id}/documents/export"


def _upstream(user_id: str, conversation_id: str) -> str:
    return f"/users/{user_id}/conversations/{conversation_id}/documents/export"


def _preview(user_id: str, attachment_id: str) -> str:
    return f"/v1/attachments/{user_id}/{attachment_id}/preview.pdf"


def _preview_upstream(user_id: str, conversation_id: str) -> str:
    return f"/users/{user_id}/conversations/{conversation_id}/office-preview"


async def _conversation(session_factory, user_id: str, agent, *, is_trial: bool = False) -> str:
    async with session_factory() as s:
        conv = ConversationTable(user_id=user_id, agent_id=agent.id, agent_name=agent.name, title="t",
                                 is_trial=is_trial, is_private=is_trial)
        s.add(conv)
        await s.commit()
        return conv.id


async def _attachment(session_factory, conversation_id: str, *, file_name: str = "report.docx",
                      mime: str = DOCX, data: bytes = b"PK office bytes", with_hash: bool = True) -> str:
    async with session_factory() as s:
        message = MessageTable(conversation_id=conversation_id, sender="user", content=file_name)
        s.add(message)
        await s.flush()
        attachment = AttachmentTable(
            message_id=message.id, file_name=file_name, mime_type=mime, size_bytes=len(data),
            content_sha256=hashlib.sha256(data).hexdigest() if with_hash else None, blob=BlobTable(data=data),
        )
        s.add(attachment)
        await s.commit()
        return attachment.id


@pytest.fixture
async def conv(session_factory, seeded_user, seeded_agent):
    return await _conversation(session_factory, seeded_user.id, seeded_agent)


def _file(content: bytes, media_type: str, filename: str | None = None) -> httpx.Response:
    headers = {"content-type": media_type}
    if filename is not None:
        headers["x-export-filename"] = quote(filename, safe="")
    return httpx.Response(200, content=content, headers=headers)


async def _cached(session_factory) -> int:
    async with session_factory() as s:
        return (await s.execute(select(func.count()).select_from(AttachmentPdfPreviewTable))).scalar_one()


# ---------------------------------------------------------------------------
# Export
# ---------------------------------------------------------------------------
async def test_export_of_someone_elses_or_a_trial_conversation_is_a_404(
    client, agents_service, session_factory, seeded_user, seeded_agent
):
    other = await _conversation(session_factory, "someone-else", seeded_agent)
    trial = await _conversation(session_factory, seeded_user.id, seeded_agent, is_trial=True)

    for conversation_id in (other, trial):
        resp = await client.post(_route(seeded_user.id, conversation_id), json={"path": BRIEF, "format": "pdf"})
        assert resp.status_code == 404
    assert agents_service.calls == []


@pytest.mark.parametrize(("fmt", "media_type", "body"), [
    ("md", "text/markdown; charset=utf-8", "# Αναφορά\n".encode()),
    ("docx", DOCX, b"PK docx"),
    ("pdf", "application/pdf", PDF),
])
async def test_the_export_passes_through_as_an_attachment(client, agents_service, seeded_user, conv,
                                                          fmt, media_type, body):
    uid = seeded_user.id
    agents_service.on("POST", _upstream(uid, conv), _file(body, media_type, f"Αναφορά Q3.{fmt}"))

    resp = await client.post(_route(uid, conv), json={"path": BRIEF, "version": 2, "format": fmt})

    assert resp.status_code == 200 and resp.content == body
    assert resp.headers["content-type"] == {"md": "text/markdown; charset=utf-8"}.get(fmt, media_type)
    assert resp.headers["content-disposition"] == (
        f"attachment; filename=\"document.{fmt}\"; filename*=UTF-8''{quote(f'Αναφορά Q3.{fmt}', safe='')}"
    )
    assert resp.headers["x-content-type-options"] == "nosniff"
    [call] = agents_service.called("POST", _upstream(uid, conv))
    assert json.loads(call.content) == {"path": BRIEF, "version": 2, "format": fmt}
    assert call.headers.get(settings.proxy.header_name)


async def test_an_ascii_title_is_also_the_plain_filename(client, agents_service, seeded_user, conv):
    agents_service.on("POST", _upstream(seeded_user.id, conv), _file(PDF, "application/pdf", "Plan (v2).pdf"))

    resp = await client.post(_route(seeded_user.id, conv), json={"path": BRIEF, "format": "pdf"})

    assert resp.headers["content-disposition"] == (
        "attachment; filename=\"Plan (v2).pdf\"; filename*=UTF-8''Plan%20%28v2%29.pdf"
    )


@pytest.mark.parametrize("name", ['a"b.pdf', "../etc.pdf", "x/y.pdf", "evil.html", "x\r\nSet-Cookie: a.pdf",
                                  ".hidden.pdf", "a" * 200 + ".pdf", None])
async def test_an_odd_upstream_name_falls_back_to_document(client, agents_service, seeded_user, conv, name):
    agents_service.on("POST", _upstream(seeded_user.id, conv), _file(PDF, "application/pdf", name))

    resp = await client.post(_route(seeded_user.id, conv), json={"path": BRIEF, "format": "pdf"})

    assert resp.status_code == 200
    assert resp.headers["content-disposition"] == (
        "attachment; filename=\"document.pdf\"; filename*=UTF-8''document.pdf"
    )


@pytest.mark.parametrize(("upstream", "status_code", "code"), [
    (503, 503, "sandbox_unavailable"),
    (504, 504, "conversion_timeout"),
    (502, 502, "conversion_failed"),
])
async def test_the_box_outcomes_are_structured(client, agents_service, seeded_user, conv, upstream, status_code, code):
    agents_service.on("POST", _upstream(seeded_user.id, conv), httpx.Response(upstream, json={"detail": "x"}))

    resp = await client.post(_route(seeded_user.id, conv), json={"path": BRIEF, "format": "docx"})

    assert resp.status_code == status_code
    assert resp.json()["detail"]["code"] == code and resp.json()["detail"]["message"]


@pytest.mark.parametrize("upstream", [404, 422])
async def test_upstream_404_and_422_stay(client, agents_service, seeded_user, conv, upstream):
    agents_service.on("POST", _upstream(seeded_user.id, conv), httpx.Response(upstream, json={"detail": "x"}))

    resp = await client.post(_route(seeded_user.id, conv), json={"path": BRIEF, "format": "md"})

    assert resp.status_code == upstream


async def test_an_unreachable_agents_service_is_a_503(client, agents_service, seeded_user, conv):
    def down(request):
        raise httpx.ConnectError("down", request=request)

    agents_service.on("POST", _upstream(seeded_user.id, conv), down)

    resp = await client.post(_route(seeded_user.id, conv), json={"path": BRIEF, "format": "md"})

    assert resp.status_code == 503


async def test_a_wrong_content_type_is_never_forwarded(client, agents_service, seeded_user, conv):
    agents_service.on("POST", _upstream(seeded_user.id, conv), _file(b"<html>", "text/html", "x.pdf"))

    resp = await client.post(_route(seeded_user.id, conv), json={"path": BRIEF, "format": "pdf"})

    assert resp.status_code == 502 and resp.json()["detail"]["code"] == "conversion_failed"


@pytest.mark.parametrize("body", [
    {"path": BRIEF, "format": "html"},
    {"path": BRIEF, "format": "pdf", "version": 0},
    {"path": BRIEF, "format": "pdf", "command": "id"},
    {"format": "pdf"},
])
async def test_a_bad_export_request_is_422_without_an_upstream_call(client, agents_service, seeded_user, conv, body):
    resp = await client.post(_route(seeded_user.id, conv), json=body)
    assert resp.status_code == 422
    assert agents_service.calls == []


# ---------------------------------------------------------------------------
# Office PDF preview
# ---------------------------------------------------------------------------
async def test_someone_elses_attachment_is_a_404_without_an_upstream_call(
    client, agents_service, session_factory, seeded_agent, seeded_user
):
    other = await _conversation(session_factory, "someone-else", seeded_agent)
    attachment = await _attachment(session_factory, other)

    resp = await client.get(_preview(seeded_user.id, attachment))
    missing = await client.get(_preview(seeded_user.id, "no-such-attachment"))

    assert resp.status_code == 404 and missing.status_code == 404
    assert agents_service.calls == []


async def test_another_users_path_is_refused(client, agents_service, session_factory, conv):
    attachment = await _attachment(session_factory, conv)

    resp = await client.get(_preview("someone-else", attachment))

    assert resp.status_code in (401, 403, 404)
    assert agents_service.calls == []


@pytest.mark.parametrize(("file_name", "mime"), [
    ("notes.txt", "text/plain"), ("page.html", "text/html"), ("legacy.doc", "application/msword"),
    ("photo.png", "image/png"),
])
async def test_only_office_files_are_previewed(client, agents_service, session_factory, seeded_user, conv,
                                               file_name, mime):
    attachment = await _attachment(session_factory, conv, file_name=file_name, mime=mime)

    resp = await client.get(_preview(seeded_user.id, attachment))

    assert resp.status_code == 415
    assert agents_service.calls == []


async def test_an_oversized_file_is_413(client, agents_service, session_factory, seeded_user, conv, monkeypatch):
    monkeypatch.setattr(settings.attachments, "pdf_preview_max_source_bytes", 4)
    attachment = await _attachment(session_factory, conv, data=b"12345")

    resp = await client.get(_preview(seeded_user.id, attachment))

    assert resp.status_code == 413
    assert agents_service.calls == []


async def test_a_render_is_cached_by_the_source_hash(
    client, agents_service, session_factory, seeded_user, seeded_agent, conv
):
    uid = seeded_user.id
    first = await _attachment(session_factory, conv, file_name="Σχέδιο.xlsx",
                              mime="application/octet-stream", data=b"PK same bytes")
    agents_service.on("POST", _preview_upstream(uid, conv), _file(PDF, "application/pdf"))

    resp = await client.get(_preview(uid, first))
    again = await client.get(_preview(uid, first))
    # The same bytes in another of the user's conversations (a fork, a re-upload).
    elsewhere = await _conversation(session_factory, uid, seeded_agent)
    copy = await _attachment(session_factory, elsewhere, file_name="copy.xlsx", data=b"PK same bytes")
    from_copy = await client.get(_preview(uid, copy))

    assert resp.status_code == again.status_code == from_copy.status_code == 200
    assert resp.content == again.content == from_copy.content == PDF
    assert resp.headers["content-type"] == "application/pdf"
    assert resp.headers["content-disposition"] == (
        "inline; filename=\"document.pdf\"; filename*=UTF-8''" + quote("Σχέδιο.pdf", safe="")
    )
    assert resp.headers["content-security-policy"] == "sandbox; default-src 'none'"
    assert resp.headers["x-content-type-options"] == "nosniff"
    [call] = agents_service.called("POST", _preview_upstream(uid, conv))
    assert call.url.params["extension"] == "xlsx"
    assert call.content == b"PK same bytes"
    assert call.headers.get(settings.proxy.header_name)
    assert await _cached(session_factory) == 1


async def test_another_users_identical_file_is_not_a_cache_hit(
    client, agents_service, session_factory, seeded_user, seeded_agent, conv, app
):
    uid = seeded_user.id
    mine = await _attachment(session_factory, conv, data=b"PK shared bytes")
    agents_service.on("POST", _preview_upstream(uid, conv), _file(PDF, "application/pdf"))
    assert (await client.get(_preview(uid, mine))).status_code == 200

    other = await _conversation(session_factory, "someone-else", seeded_agent)
    theirs = await _attachment(session_factory, other, data=b"PK shared bytes")
    async with session_factory() as s:
        assert await preview_utils._cached_preview(s, "someone-else", hashlib.sha256(b"PK shared bytes").hexdigest()) is None
        assert await preview_utils._cached_preview(s, uid, hashlib.sha256(b"PK shared bytes").hexdigest()) == PDF
    assert theirs


async def test_an_upload_without_a_recorded_hash_is_hashed_and_cached(
    client, agents_service, session_factory, seeded_user, conv
):
    uid = seeded_user.id
    attachment = await _attachment(session_factory, conv, file_name="deck.pptx", data=b"PK deck", with_hash=False)
    agents_service.on("POST", _preview_upstream(uid, conv), _file(PDF, "application/pdf"))

    assert (await client.get(_preview(uid, attachment))).status_code == 200
    assert (await client.get(_preview(uid, attachment))).status_code == 200

    assert len(agents_service.called("POST", _preview_upstream(uid, conv))) == 1
    async with session_factory() as s:
        row = (await s.execute(select(AttachmentPdfPreviewTable))).scalar_one()
    assert row.source_sha256 == hashlib.sha256(b"PK deck").hexdigest()


@pytest.mark.parametrize(("reply", "status_code", "code"), [
    (httpx.Response(503, json={"detail": "sandbox_unavailable"}), 503, "sandbox_unavailable"),
    (httpx.Response(504, json={"detail": "conversion_timeout"}), 504, "conversion_timeout"),
    (httpx.Response(502, json={"detail": "conversion_failed"}), 502, "conversion_failed"),
    (_file(b"not a pdf", "application/pdf"), 502, "conversion_failed"),
    (_file(b"<html>", "text/html"), 502, "conversion_failed"),
])
async def test_a_failed_render_is_structured_and_not_cached(
    client, agents_service, session_factory, seeded_user, conv, reply, status_code, code
):
    attachment = await _attachment(session_factory, conv)
    agents_service.on("POST", _preview_upstream(seeded_user.id, conv), reply)

    resp = await client.get(_preview(seeded_user.id, attachment))

    assert resp.status_code == status_code and resp.json()["detail"]["code"] == code
    assert await _cached(session_factory) == 0


def test_a_preview_lives_and_dies_with_its_attachment():
    """The cache row hangs off the attachment with ON DELETE CASCADE (a deleted
    message, conversation or account takes it along); migration 0051 says the same."""
    [fk] = AttachmentPdfPreviewTable.__table__.c.attachment_id.foreign_keys
    assert fk.column.table.name == "attachments" and fk.ondelete == "CASCADE"
    assert AttachmentPdfPreviewTable.__table__.c.source_sha256.index
