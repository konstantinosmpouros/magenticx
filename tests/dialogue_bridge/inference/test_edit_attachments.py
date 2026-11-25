"""An edit carries the uploads the user kept, and only those.

Editing a message makes a new sibling: the files the user kept are copied onto
it (their own rows and bytes, same ``/conversation/input/`` name), a file they
removed stays on the old branch only, and new files arrive like on a send.
"""
from __future__ import annotations

import base64
import hashlib

import pytest
import pytest_asyncio
from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from core.database import AgentTable, AttachmentTable, BlobTable, ConversationTable, MessageTable
from schema import InferenceStartPayload, MessageIn
import engine.inference.start as inference_start_module
from engine.inference.start import start_inference_flow


def _upload(message_id: str, name: str, data: bytes) -> AttachmentTable:
    return AttachmentTable(
        message_id=message_id,
        file_name=name,
        mime_type="text/plain",
        size_bytes=len(data),
        content_sha256=hashlib.sha256(data).hexdigest(),
        workspace_name=name,
        blob=BlobTable(data=data),
    )


@pytest_asyncio.fixture
async def turn_with_files(session_factory, seeded_user, seeded_agent, monkeypatch):
    """A finished turn whose user message holds two uploads."""

    async def fake_get_agent_by_id(agent_id):
        return seeded_agent if agent_id == seeded_agent.id else None

    monkeypatch.setattr(inference_start_module, "get_agent_by_id", fake_get_agent_by_id)
    async with session_factory() as session:
        conversation = ConversationTable(
            user_id=seeded_user.id,
            agent_id=seeded_agent.id,
            agent_name=seeded_agent.name,
            title="Edit attachments",
            is_private=False,
        )
        session.add(conversation)
        await session.flush()
        user_message = MessageTable(conversation_id=conversation.id, sender="user", content="read these")
        session.add(user_message)
        await session.flush()
        notes = _upload(user_message.id, "notes.txt", b"notes")
        plan = _upload(user_message.id, "plan.txt", b"plan")
        other_message = MessageTable(conversation_id=conversation.id, sender="user", content="elsewhere")
        session.add_all([notes, plan, other_message])
        await session.flush()
        stray = _upload(other_message.id, "stray.txt", b"stray")
        session.add(stray)
        session.add(MessageTable(
            conversation_id=conversation.id,
            parent_message_id=user_message.id,
            sender="ai",
            content="done",
            agent_id=seeded_agent.id,
            agent_name=seeded_agent.name,
        ))
        await session.commit()
        return {
            "conversation_id": conversation.id,
            "message_id": user_message.id,
            "notes": notes.id,
            "plan": plan.id,
            "stray": stray.id,
        }


async def _edit(session_factory, user, turn, keep, attachments=()):
    async with session_factory() as db:
        response = await start_inference_flow(
            db=db,
            user=user,
            payload=InferenceStartPayload(
                mode="edit",
                conversationId=turn["conversation_id"],
                targetMessageId=turn["message_id"],
                keepAttachmentIds=keep,
                message=MessageIn(sender="user", content="edited", attachments=list(attachments)),
            ),
        )
    return response.message.parentMessageId


async def _files_of(session_factory, message_id):
    async with session_factory() as session:
        rows = await session.execute(
            select(AttachmentTable)
            .options(selectinload(AttachmentTable.blob))
            .where(AttachmentTable.message_id == message_id)
            .order_by(AttachmentTable.file_name)
        )
        return [(row.id, row.file_name, row.workspace_name, row.blob.data) for row in rows.scalars()]


async def test_edit_keeps_only_the_files_left_in(session_factory, seeded_user, turn_with_files):
    edited_id = await _edit(session_factory, seeded_user, turn_with_files, [turn_with_files["plan"]])

    files = await _files_of(session_factory, edited_id)
    assert [(name, workspace, data) for _id, name, workspace, data in files] == [("plan.txt", "plan.txt", b"plan")]
    # Its own row: deleting the old branch must not take the new one's file.
    assert files[0][0] != turn_with_files["plan"]
    # The edited message keeps both of its files.
    assert len(await _files_of(session_factory, turn_with_files["message_id"])) == 2


async def test_edit_without_keeping_drops_every_file(session_factory, seeded_user, turn_with_files):
    edited_id = await _edit(session_factory, seeded_user, turn_with_files, [])
    assert await _files_of(session_factory, edited_id) == []


async def test_edit_adds_new_files_next_to_kept_ones(session_factory, seeded_user, turn_with_files):
    new_file = {"name": "extra.txt", "mime": "text/plain", "dataB64": base64.b64encode(b"extra").decode(), "size": 5}
    edited_id = await _edit(
        session_factory, seeded_user, turn_with_files, [turn_with_files["notes"]], attachments=[new_file]
    )
    names = [name for _id, name, _workspace, _data in await _files_of(session_factory, edited_id)]
    assert names == ["extra.txt", "notes.txt"]


async def test_edit_refuses_a_file_from_another_message(session_factory, seeded_user, turn_with_files):
    with pytest.raises(HTTPException) as caught:
        await _edit(session_factory, seeded_user, turn_with_files, [turn_with_files["stray"]])
    assert caught.value.status_code == 400


def test_kept_files_are_for_edits_only():
    with pytest.raises(ValidationError):
        InferenceStartPayload(
            mode="send",
            conversationId="c",
            parentMessageId="p",
            agentId="a",
            keepAttachmentIds=["x"],
            message=MessageIn(sender="user", content="hi"),
        )
