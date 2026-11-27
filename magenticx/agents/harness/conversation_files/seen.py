"""What the agent has seen of each canvas document (plan 44, Phase 4.3).

The user edits a document in the canvas between turns; each save is a ``user``
version (:mod:`.versions`) and also rewrites the file, so the agent's next turn
already reads the latest text. What it lacks is *that* the user changed it and
*how*. ``conversation_file_seen`` keeps, per document, the version the agent
last saw; the run that starts next diffs that version against the latest and
tells the agent in one short note (:mod:`harness.canvas.notes`).

The markers move at two moments, both monotonic (``GREATEST``, never back):

* **run start** (:meth:`DocumentSeenStore.turn_state` + :meth:`mark_seen`) —
  every document is marked seen at its latest version, because the note about
  it (or, the first time a document is met, nothing at all: no row means no
  diff) is now in the turn the model reads;
* **run end** (:meth:`advance_after_run`, after the capture recorded the
  agent's own new versions) — the marker moves over the consecutive *agent*
  versions only, and stops before the first user version it has not seen. A
  save the user made while the run was going is therefore not swallowed: the
  next turn still gets its diff.

The markers belong to a branch, like the versions they point at. The DDL is in
:mod:`.store`, beside the versions whose lifetime the markers share (fork
copy, reap, purge).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from core.logging import get_logger
from harness.conversation_files.versions import DocumentVersionStore

logger = get_logger(__name__)

#: How many documents one turn looks at — a conversation rarely has more than
#: a handful, and the note is capped far below what this many could fill.
MAX_TURN_DOCUMENTS = 50
#: How many of them get their texts read for a diff; the rest are named only.
MAX_DIFFED_DOCUMENTS = 10


@dataclass(frozen=True)
class PendingEdit:
    """A document the user changed since the agent last saw it.

    ``seen_text`` / ``latest_text`` are None for a document past
    :data:`MAX_DIFFED_DOCUMENTS`: the note names it without a diff.
    """

    path: str
    seen_version: int
    latest_version: int
    seen_text: str | None = None
    latest_text: str | None = None


@dataclass(frozen=True)
class TurnState:
    """What a run start found: the user's edits to report, and the markers to set."""

    edits: list[PendingEdit] = field(default_factory=list)
    #: path → the latest version, for every document of the conversation.
    marks: dict[str, int] = field(default_factory=dict)


class DocumentSeenStore(DocumentVersionStore):
    """The seen markers of one user's conversations, over the versions table.

    A subclass so it reads versions with the very decrypting reader the
    canvas routes use. Every statement filters on ``user_id``,
    ``conversation_id`` and the store's branch.
    """

    async def turn_state(self, user_id: str, conversation_id: str) -> TurnState:
        """The user's edits since the agent's last look, newest document first.

        A document with no marker yet is being met for the first time (a
        document from before this release, or the first turn after the agent
        made it): no diff, only a marker. A document whose newer versions are
        all the agent's (a capture that failed to mark) gets a marker, no note.
        """
        async with self._connect(user_id, conversation_id) as conn:
            cur = await conn.execute(
                "SELECT v.path, max(v.version) AS latest, s.agent_seen_version AS seen, "
                "coalesce(bool_or(v.author = 'user' AND v.version > s.agent_seen_version), false) AS user_edited "
                "FROM conversation_file_versions v "
                "LEFT JOIN conversation_file_seen s ON s.conversation_id = v.conversation_id "
                "AND s.branch_thread_id = v.branch_thread_id AND s.path = v.path AND s.user_id = v.user_id "
                "WHERE v.conversation_id = %(conversation_id)s AND v.branch_thread_id = %(branch)s "
                "AND v.user_id = %(user_id)s "
                "GROUP BY v.path, s.agent_seen_version "
                "ORDER BY max(v.created_at) DESC, v.path LIMIT %(limit)s",
                {"user_id": user_id, "conversation_id": conversation_id, "limit": MAX_TURN_DOCUMENTS},
            )
            rows = await cur.fetchall()
            state = TurnState()
            for row in rows:
                path, latest, seen = row["path"], int(row["latest"]), row["seen"]
                state.marks[path] = latest
                if seen is None or int(seen) >= latest or not row["user_edited"]:
                    continue
                if len(state.edits) >= MAX_DIFFED_DOCUMENTS:
                    state.edits.append(PendingEdit(path=path, seen_version=int(seen), latest_version=latest))
                    continue
                before = await self._read_version(conn, user_id, conversation_id, path, int(seen))
                after = await self._read_version(conn, user_id, conversation_id, path, latest)
                state.edits.append(PendingEdit(
                    path=path, seen_version=int(seen), latest_version=latest,
                    seen_text=before.content if before is not None else None,
                    latest_text=after.content if after is not None else None,
                ))
        return state

    async def mark_seen(self, user_id: str, conversation_id: str, marks: dict[str, int]) -> int:
        """Set each document's marker to at least the given version. Returns how many rows changed."""
        if not marks:
            return 0
        changed = 0
        async with self._connect(user_id, conversation_id) as conn, conn.transaction():
            for path, version in marks.items():
                cur = await conn.execute(
                    "INSERT INTO conversation_file_seen "
                    "(conversation_id, branch_thread_id, path, user_id, agent_seen_version) "
                    "VALUES (%(conversation_id)s, %(branch)s, %(path)s, %(user_id)s, %(version)s) "
                    "ON CONFLICT (conversation_id, branch_thread_id, path) DO UPDATE SET "
                    "agent_seen_version = EXCLUDED.agent_seen_version, updated_at = now() "
                    "WHERE conversation_file_seen.user_id = EXCLUDED.user_id "
                    "AND conversation_file_seen.agent_seen_version < EXCLUDED.agent_seen_version",
                    {"user_id": user_id, "conversation_id": conversation_id, "path": path, "version": int(version)},
                )
                changed += cur.rowcount or 0
        return changed

    async def advance_after_run(self, user_id: str, conversation_id: str) -> int:
        """Run end: move each marker over the agent's own versions, up to the first unseen user one.

        A document the agent has no marker for yet (it made it in this run)
        counts from nothing, so its agent versions are marked and a later user
        version stays unseen. Returns how many rows changed.
        """
        async with self._connect(user_id, conversation_id) as conn:
            cur = await conn.execute(
                "WITH docs AS ("
                "SELECT v.path, coalesce(s.agent_seen_version, 0) AS seen, max(v.version) AS latest, "
                "min(v.version) FILTER (WHERE v.author = 'user' "
                "AND v.version > coalesce(s.agent_seen_version, 0)) AS first_user "
                "FROM conversation_file_versions v "
                "LEFT JOIN conversation_file_seen s ON s.conversation_id = v.conversation_id "
                "AND s.branch_thread_id = v.branch_thread_id AND s.path = v.path AND s.user_id = v.user_id "
                "WHERE v.conversation_id = %(conversation_id)s AND v.branch_thread_id = %(branch)s "
                "AND v.user_id = %(user_id)s "
                "GROUP BY v.path, s.agent_seen_version), "
                "target AS (SELECT path, seen, coalesce(first_user - 1, latest) AS version FROM docs) "
                "INSERT INTO conversation_file_seen (conversation_id, branch_thread_id, path, user_id, "
                "agent_seen_version) "
                "SELECT %(conversation_id)s, %(branch)s, path, %(user_id)s, version FROM target WHERE version > seen "
                "ON CONFLICT (conversation_id, branch_thread_id, path) DO UPDATE SET "
                "agent_seen_version = EXCLUDED.agent_seen_version, updated_at = now() "
                "WHERE conversation_file_seen.user_id = EXCLUDED.user_id "
                "AND conversation_file_seen.agent_seen_version < EXCLUDED.agent_seen_version",
                {"user_id": user_id, "conversation_id": conversation_id},
            )
            return cur.rowcount or 0

    async def seen_versions(self, user_id: str, conversation_id: str) -> dict[str, int]:
        """path → the agent's seen version, for every marked document (tests, diagnostics)."""
        async with self._connect(user_id, conversation_id) as conn:
            cur = await conn.execute(
                "SELECT path, agent_seen_version FROM conversation_file_seen "
                "WHERE conversation_id = %(conversation_id)s AND branch_thread_id = %(branch)s "
                "AND user_id = %(user_id)s ORDER BY path",
                {"user_id": user_id, "conversation_id": conversation_id},
            )
            rows: list[dict[str, Any]] = await cur.fetchall()
        return {row["path"]: int(row["agent_seen_version"]) for row in rows}


__all__ = ["MAX_DIFFED_DOCUMENTS", "MAX_TURN_DOCUMENTS", "DocumentSeenStore", "PendingEdit", "TurnState"]
