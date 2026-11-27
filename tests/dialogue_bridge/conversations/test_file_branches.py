"""Which branch a call about a conversation's files is for (branch-scoped conversation files).

Pinned: the browser names a message and the bridge resolves the branch — the
nearest answer at or above it that has a checkpoint thread — never crossing
into another conversation; a fork sends the answers up to its fork point; a
run's own captures name its thread.
"""
from __future__ import annotations

import pytest
from fastapi import HTTPException

from core.database import ConversationTable, MessageTable
from engine.conversations.file_branches import (
    LEGACY_BRANCH,
    FileBranch,
    branch_of_path,
    resolve_file_branch,
    run_file_branch,
)
from engine.inference.history import answers_up_to

pytestmark = pytest.mark.asyncio


async def _tree(session_factory, user, agent):
    """u1 → a1 (T1) → u2 → a2 (T1); an edit of u2 → u2' → a3 (T2); and a legacy answer a0 on no thread.

    Returns the conversation id and the messages by name.
    """
    async with session_factory() as db:
        conversation = ConversationTable(user_id=user.id, agent_id=agent.id, title="t")
        db.add(conversation)
        await db.flush()
        rows: dict[str, MessageTable] = {}

        def add(name, sender, parent=None, thread=None):
            row = MessageTable(conversation_id=conversation.id, sender=sender, content=name,
                               parent_message_id=rows[parent].id if parent else None,
                               checkpoint_thread_id=thread)
            db.add(row)
            rows[name] = row
            return row

        add("u1", "user")
        await db.flush()
        add("a1", "ai", "u1", "T1")
        await db.flush()
        add("u2", "user", "a1")
        add("u2'", "user", "a1")
        await db.flush()
        add("a2", "ai", "u2", "T1")
        add("a3", "ai", "u2'", "T2")
        await db.flush()
        ids = {name: row.id for name, row in rows.items()}
        await db.commit()
        return conversation.id, ids, list(rows.values())


async def test_a_message_resolves_to_the_nearest_answer_with_a_thread(session_factory, seeded_user, seeded_agent):
    conversation_id, ids, _ = await _tree(session_factory, seeded_user, seeded_agent)
    async with session_factory() as db:
        assert await resolve_file_branch(db, conversation_id, ids["a2"]) == FileBranch("T1", ids["a2"])
        # A user message is on the branch of the answer above it.
        assert await resolve_file_branch(db, conversation_id, ids["u2"]) == FileBranch("T1", ids["a1"])
        # The edited branch has its own thread.
        assert await resolve_file_branch(db, conversation_id, ids["a3"]) == FileBranch("T2", ids["a3"])
        # Nothing above it has a thread: the files from before branches.
        assert await resolve_file_branch(db, conversation_id, ids["u1"]) == FileBranch(LEGACY_BRANCH)


async def test_a_message_of_another_conversation_is_a_404(session_factory, seeded_user, seeded_agent):
    first, ids, _ = await _tree(session_factory, seeded_user, seeded_agent)
    second, _, _ = await _tree(session_factory, seeded_user, seeded_agent)
    async with session_factory() as db:
        for conversation_id, message_id in ((second, ids["a2"]), (first, "no-such-message")):
            with pytest.raises(HTTPException) as refused:
                await resolve_file_branch(db, conversation_id, message_id)
            assert refused.value.status_code == 404


async def test_a_fork_names_the_answers_up_to_its_fork_point(session_factory, seeded_user, seeded_agent):
    _, ids, rows = await _tree(session_factory, seeded_user, seeded_agent)

    assert answers_up_to(rows, ids["a2"]) == [ids["a1"], ids["a2"]]
    # An edit of u2 forks at a1: a2, the answer it replaces, is not among them.
    assert answers_up_to(rows, ids["a1"]) == [ids["a1"]]
    assert answers_up_to(rows, "not-here") == []


async def test_a_run_and_a_forked_path_name_their_own_branch(session_factory, seeded_user, seeded_agent):
    _, ids, rows = await _tree(session_factory, seeded_user, seeded_agent)
    by_id = {row.id: row for row in rows}

    assert run_file_branch(by_id[ids["a3"]]).params() == {"branch_thread_id": "T2", "message_id": ids["a3"]}
    path = [by_id[ids[name]] for name in ("u1", "a1", "u2", "a2")]
    assert branch_of_path(path) == FileBranch("T1", ids["a2"])
    assert branch_of_path(path[:1]).params() == {"branch_thread_id": LEGACY_BRANCH}
