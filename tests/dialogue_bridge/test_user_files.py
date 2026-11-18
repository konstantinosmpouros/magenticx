"""GET /v1/attachments/files/{user_id} — the Artifacts page's listing (plan 44).

Owner scope, the kind / type / search filters, keyset pagination, and what is
never listed (another user's files, private chats and trials, deleted
conversations and messages, rows without a blob). The listing is metadata
only, so the test also pins that no content field ever appears.
"""
from __future__ import annotations

from datetime import datetime, timedelta

from sqlalchemy import delete

from core.database import AttachmentTable, BlobTable, ConversationTable, MessageTable, UserTable
from utils.user_files import classify_file_type
from utils.validators import validate_userId

BASE = datetime(2026, 11, 1, 12, 0, 0)


async def _conversation(session_factory, user_id: str, agent, *, title: str, **flags) -> str:
    # is_private is spelt out: on SQLite the column's server_default "false" is
    # stored as the text 'false', which reads back as True — a private chat,
    # which this listing (rightly) hides.
    flags.setdefault("is_private", False)
    async with session_factory() as session:
        conv = ConversationTable(
            user_id=user_id, agent_id=agent.id, agent_name=agent.name, title=title, **flags
        )
        session.add(conv)
        await session.commit()
        return conv.id


async def _file(
    session_factory,
    conversation_id: str,
    *,
    name: str,
    mime: str,
    minutes: int,
    origin: str = "upload",
    presented: bool = False,
    title: str | None = None,
    with_blob: bool = True,
) -> dict[str, str]:
    """One message carrying one attachment, created ``minutes`` after BASE."""
    async with session_factory() as session:
        message = MessageTable(
            conversation_id=conversation_id,
            sender="user" if origin == "upload" else "assistant",
            content=name,
        )
        session.add(message)
        await session.flush()
        attachment = AttachmentTable(
            message_id=message.id,
            file_name=name,
            mime_type=mime,
            size_bytes=len(name),
            origin=origin,
            presented=presented,
            title=title,
            blob=BlobTable(data=name.encode()) if with_blob else None,
            created_at=BASE + timedelta(minutes=minutes),
        )
        session.add(attachment)
        await session.commit()
        return {"message_id": message.id, "attachment_id": attachment.id, "blob_id": attachment.blob_id}


def _names(payload) -> list[str]:
    return [item["fileName"] for item in payload["items"]]


async def _seed_three_conversations(session_factory, user, agent):
    """Uploads and generated files across three conversations, newest last."""
    a = await _conversation(session_factory, user.id, agent, title="Budget")
    b = await _conversation(session_factory, user.id, agent, title="Launch deck")
    c = await _conversation(session_factory, user.id, agent, title="Notes", is_archived=True)
    await _file(session_factory, a, name="figures.xlsx", mime="application/octet-stream", minutes=1)
    await _file(session_factory, a, name="report.pdf", mime="application/pdf", minutes=2,
                origin="generated", presented=True, title="Q3 report")
    await _file(session_factory, b, name="Deck.PPTX", mime="application/vnd.ms-powerpoint", minutes=3)
    await _file(session_factory, b, name="brief.docx",
                mime="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                minutes=4, origin="generated", presented=True)
    await _file(session_factory, c, name="photo.png", mime="image/png", minutes=5)
    await _file(session_factory, c, name="data.csv", mime="text/csv", minutes=6, origin="generated", presented=True)
    await _file(session_factory, c, name="readme.md", mime="text/markdown", minutes=7)
    await _file(session_factory, c, name="archive.zip", mime="application/zip", minutes=8)
    return a, b, c


async def test_lists_all_files_across_conversations_newest_first(client, session_factory, seeded_user, seeded_agent):
    a, b, c = await _seed_three_conversations(session_factory, seeded_user, seeded_agent)

    response = await client.get(f"/v1/attachments/files/{seeded_user.id}")

    assert response.status_code == 200
    payload = response.json()
    assert _names(payload) == [
        "archive.zip", "readme.md", "data.csv", "photo.png", "brief.docx", "Deck.PPTX", "report.pdf", "figures.xlsx",
    ]
    assert payload["nextCursor"] is None
    by_name = {item["fileName"]: item for item in payload["items"]}
    report = by_name["report.pdf"]
    assert report["kind"] == "output"
    assert report["presented"] is True
    assert report["title"] == "Q3 report"
    assert report["conversationId"] == a
    assert report["conversationTitle"] == "Budget"
    assert report["blobId"] and report["messageId"] and report["attachmentId"]
    assert by_name["figures.xlsx"]["kind"] == "input"
    assert by_name["photo.png"]["conversationId"] == c  # archived chats still count
    # Metadata only: no content is ever serialised.
    for item in payload["items"]:
        assert "data" not in item and "dataB64" not in item


async def test_types_follow_mime_then_extension(client, session_factory, seeded_user, seeded_agent):
    await _seed_three_conversations(session_factory, seeded_user, seeded_agent)

    payload = (await client.get(f"/v1/attachments/files/{seeded_user.id}")).json()

    assert {item["fileName"]: item["type"] for item in payload["items"]} == {
        "figures.xlsx": "sheet",  # octet-stream: named by its extension
        "report.pdf": "pdf",
        "Deck.PPTX": "slides",  # extension match is case-insensitive
        "brief.docx": "doc",
        "photo.png": "image",
        "data.csv": "sheet",  # text/csv is a sheet, not text: the first rule wins
        "readme.md": "text",
        "archive.zip": "other",
    }


async def test_kind_and_type_filters_agree_with_labels(client, session_factory, seeded_user, seeded_agent):
    await _seed_three_conversations(session_factory, seeded_user, seeded_agent)
    url = f"/v1/attachments/files/{seeded_user.id}"

    inputs = (await client.get(url, params={"kind": "input"})).json()
    outputs = (await client.get(url, params={"kind": "output"})).json()
    sheets = (await client.get(url, params={"type": "sheet"})).json()
    texts = (await client.get(url, params={"type": "text"})).json()
    others = (await client.get(url, params={"type": "other"})).json()
    output_sheets = (await client.get(url, params={"kind": "output", "type": "sheet"})).json()

    assert _names(inputs) == ["archive.zip", "readme.md", "photo.png", "Deck.PPTX", "figures.xlsx"]
    assert _names(outputs) == ["data.csv", "brief.docx", "report.pdf"]
    assert _names(sheets) == ["data.csv", "figures.xlsx"]
    assert _names(texts) == ["readme.md"]
    assert _names(others) == ["archive.zip"]
    assert _names(output_sheets) == ["data.csv"]
    # Every filter returns only rows labelled with the type it asked for.
    for file_type in ("pdf", "doc", "sheet", "slides", "image", "text", "other"):
        page = (await client.get(url, params={"type": file_type})).json()
        assert page["items"], file_type
        assert {item["type"] for item in page["items"]} == {file_type}


async def test_search_is_case_insensitive_substring_with_wildcards_escaped(
    client, session_factory, seeded_user, seeded_agent
):
    conv = await _conversation(session_factory, seeded_user.id, seeded_agent, title="Search")
    await _file(session_factory, conv, name="Annual_Report.pdf", mime="application/pdf", minutes=1)
    await _file(session_factory, conv, name="annualXreport.pdf", mime="application/pdf", minutes=2)
    await _file(session_factory, conv, name="100% done.txt", mime="text/plain", minutes=3)
    url = f"/v1/attachments/files/{seeded_user.id}"

    assert _names((await client.get(url, params={"q": "REPORT"})).json()) == ["annualXreport.pdf", "Annual_Report.pdf"]
    # "_" and "%" are literal, not LIKE wildcards.
    assert _names((await client.get(url, params={"q": "annual_"})).json()) == ["Annual_Report.pdf"]
    assert _names((await client.get(url, params={"q": "100%"})).json()) == ["100% done.txt"]
    assert _names((await client.get(url, params={"q": "   "})).json()) == [
        "100% done.txt", "annualXreport.pdf", "Annual_Report.pdf",
    ]


async def test_keyset_pagination_walks_every_row_once(client, session_factory, seeded_user, seeded_agent):
    conv = await _conversation(session_factory, seeded_user.id, seeded_agent, title="Many")
    # Two rows share a timestamp, so the id tie-break is exercised.
    for i in range(7):
        await _file(session_factory, conv, name=f"f{i}.txt", mime="text/plain", minutes=min(i, 5))
    url = f"/v1/attachments/files/{seeded_user.id}"

    seen: list[str] = []
    cursor = None
    pages = 0
    while True:
        params = {"limit": 3, **({"cursor": cursor} if cursor else {})}
        payload = (await client.get(url, params=params)).json()
        seen.extend(item["attachmentId"] for item in payload["items"])
        pages += 1
        cursor = payload["nextCursor"]
        if cursor is None:
            break

    assert pages == 3
    assert len(seen) == 7 and len(set(seen)) == 7
    full = (await client.get(url, params={"limit": 100})).json()
    assert [item["attachmentId"] for item in full["items"]] == seen


async def test_bad_parameters_are_400_or_422(client, seeded_user):
    url = f"/v1/attachments/files/{seeded_user.id}"

    assert (await client.get(url, params={"cursor": "not-a-cursor!"})).status_code == 400
    assert (await client.get(url, params={"kind": "both"})).status_code == 422
    assert (await client.get(url, params={"type": "video"})).status_code == 422
    assert (await client.get(url, params={"limit": 0})).status_code == 422
    assert (await client.get(url, params={"limit": 101})).status_code == 422
    assert (await client.get(url, params={"q": "x" * 201})).status_code == 422


async def test_only_the_owners_files_and_never_private_trial_or_blobless(
    client, session_factory, seeded_user, seeded_agent
):
    async with session_factory() as session:
        other = UserTable(username="someone-else", oidc_subject="oid-someone-else", is_active=True)
        session.add(other)
        await session.commit()
        other_id = other.id
    mine = await _conversation(session_factory, seeded_user.id, seeded_agent, title="Mine")
    theirs = await _conversation(session_factory, other_id, seeded_agent, title="Theirs")
    private = await _conversation(session_factory, seeded_user.id, seeded_agent, title="Incognito", is_private=True)
    trial = await _conversation(
        session_factory, seeded_user.id, seeded_agent, title="Try it", is_private=True, is_trial=True
    )
    await _file(session_factory, mine, name="mine.txt", mime="text/plain", minutes=1)
    await _file(session_factory, mine, name="no-blob.txt", mime="text/plain", minutes=2, with_blob=False)
    await _file(session_factory, theirs, name="theirs.txt", mime="text/plain", minutes=3)
    await _file(session_factory, private, name="private.txt", mime="text/plain", minutes=4)
    await _file(session_factory, trial, name="trial.txt", mime="text/plain", minutes=5)

    payload = (await client.get(f"/v1/attachments/files/{seeded_user.id}")).json()

    assert _names(payload) == ["mine.txt"]


async def test_deleted_conversations_and_messages_drop_out(client, session_factory, seeded_user, seeded_agent):
    kept = await _conversation(session_factory, seeded_user.id, seeded_agent, title="Kept")
    gone = await _conversation(session_factory, seeded_user.id, seeded_agent, title="Gone")
    await _file(session_factory, kept, name="kept.txt", mime="text/plain", minutes=1)
    removed_message = await _file(session_factory, kept, name="edited-away.txt", mime="text/plain", minutes=2)
    await _file(session_factory, gone, name="gone.txt", mime="text/plain", minutes=3)
    url = f"/v1/attachments/files/{seeded_user.id}"
    assert len((await client.get(url)).json()["items"]) == 3

    # Deletes are hard. SQLite in the tests does not enforce FK cascades, so the
    # rows a Postgres cascade would take are removed with them explicitly.
    async with session_factory() as session:
        await session.execute(delete(AttachmentTable).where(AttachmentTable.message_id == removed_message["message_id"]))
        await session.execute(delete(MessageTable).where(MessageTable.id == removed_message["message_id"]))
        gone_messages = [m for (m,) in (await session.execute(
            MessageTable.__table__.select().with_only_columns(MessageTable.id).where(MessageTable.conversation_id == gone)
        )).all()]
        await session.execute(delete(AttachmentTable).where(AttachmentTable.message_id.in_(gone_messages)))
        await session.execute(delete(MessageTable).where(MessageTable.conversation_id == gone))
        await session.execute(delete(ConversationTable).where(ConversationTable.id == gone))
        await session.commit()

    assert _names((await client.get(url)).json()) == ["kept.txt"]


async def test_listing_requires_a_session(app, client, seeded_user):
    # Drop only the auth override: the real dependency runs and, with no
    # session cookie, refuses before any query.
    app.dependency_overrides.pop(validate_userId, None)

    response = await client.get(f"/v1/attachments/files/{seeded_user.id}")

    assert response.status_code == 401


def test_classify_file_type_edge_cases():
    assert classify_file_type("application/pdf; charset=binary", "x") == "pdf"
    assert classify_file_type("", "no-extension") == "other"
    assert classify_file_type(None, None) == "other"
    assert classify_file_type("image/svg+xml", "chart.svg") == "image"
    assert classify_file_type("application/json", "data.json") == "text"

