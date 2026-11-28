"""The one-shot route the bridge calls at boot: import every branch's legacy scratch files.

Pinned here: internal callers only; 503 while the checkpointer or the store is
not ready, or when a branch failed (the bridge retries the batch); each branch
is imported under its own (user, conversation, thread); an id this service
would never key a row on is skipped. Delete with the route.
"""
from __future__ import annotations

import importlib

import pytest

URL = "/internal/scratch/legacy-import"
BRANCHES = {"branches": [
    {"thread_id": "t-1", "user_id": "u1", "conversation_id": "c1"},
    {"thread_id": "t-2", "user_id": "u1", "conversation_id": "c2"},
]}


class _Store:
    async def ensure_setup(self):
        return None


@pytest.fixture
def route(agents_service, monkeypatch):
    """The route module, made ready, with the import recorded instead of run."""
    module = importlib.import_module("router.scratch_import")
    migration = importlib.import_module("harness.filesystem.scratch_migration")
    calls: list[tuple] = []
    outcome: dict = {"fail": set()}

    async def fake_import(store, scope, *, agent_slug):
        calls.append((scope.user_id, scope.conversation_id, scope.branch_thread_id, agent_slug))
        if scope.branch_thread_id in outcome["fail"]:
            raise ValueError("unreadable checkpoint")
        return 2

    monkeypatch.setattr(module, "has_checkpointer_initialized", lambda: True)
    monkeypatch.setattr(module, "has_memory_pool", lambda: True)
    monkeypatch.setattr(module, "BranchScratchStore", _Store)
    monkeypatch.setattr(migration, "import_legacy_scratch", fake_import)
    return module, calls, outcome


async def test_only_an_internal_caller_may_import(client, route):
    response = await client.post(URL, json=BRANCHES)
    assert response.status_code in (401, 403)
    assert route[1] == []


async def test_each_branch_is_imported_under_its_own_scope(client, internal_headers, route):
    _module, calls, _outcome = route

    response = await client.post(URL, json=BRANCHES, headers=internal_headers)

    assert response.status_code == 200
    assert response.json() == {"branches": 2, "files": 4}
    assert calls == [("u1", "c1", "t-1", "legacy-import"), ("u1", "c2", "t-2", "legacy-import")]


async def test_not_ready_answers_503_so_the_bridge_retries(client, internal_headers, route, monkeypatch):
    module, calls, _outcome = route
    monkeypatch.setattr(module, "has_checkpointer_initialized", lambda: False)

    assert (await client.post(URL, json=BRANCHES, headers=internal_headers)).status_code == 503
    assert calls == []


async def test_a_failed_branch_answers_503_after_trying_the_rest(client, internal_headers, route):
    _module, calls, outcome = route
    outcome["fail"].add("t-1")

    assert (await client.post(URL, json=BRANCHES, headers=internal_headers)).status_code == 503
    assert [call[2] for call in calls] == ["t-1", "t-2"]


async def test_an_id_that_would_never_key_a_row_is_skipped(client, internal_headers, route):
    _module, calls, _outcome = route
    body = {"branches": [{"thread_id": "../other", "user_id": "u1", "conversation_id": "c1"},
                         {"thread_id": "t-3", "user_id": "u1", "conversation_id": "c3"}]}

    response = await client.post(URL, json=body, headers=internal_headers)

    assert response.status_code == 200
    assert [call[2] for call in calls] == ["t-3"]
