"""A message the user sent while a run worked: message_kind_enum += interjection

Revision ID: 0052_message_kind_interjection
Revises: 0051_attachment_pdf_previews
Create Date: 2026-11-23

Steering (SSE plan, phase 5): a message the user sends while a run works is
read by that run at its next step. It is now also kept as its own row in
``messages`` (sender ``user``, ``kind = 'interjection'``, parented on the
answer that read it), so search, embeddings, the data export and a retry see
it. It is not part of the branch tree: ``ConversationTable.messages`` leaves
these rows out.

Additive only: one new enum value. ``ALTER TYPE … ADD VALUE`` cannot be undone
in Postgres without rebuilding the type, and the rows hold the user's words, so
the downgrade changes nothing. **Rolling the bridge back below this release:**
the older code does not know the value and fails to load a conversation that
has such a row — remove the rows by hand first, on purpose, if that is ever
needed (``DELETE FROM messages WHERE kind = 'interjection'``; their text stays
in the answers' ``raw_events``).
"""
from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "0052_message_kind_interjection"
down_revision: str | None = "0051_attachment_pdf_previews"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    if op.get_bind().dialect.name == "postgresql":
        # IF NOT EXISTS: safe to re-run; allowed inside a transaction since PG 12.
        op.execute("ALTER TYPE message_kind_enum ADD VALUE IF NOT EXISTS 'interjection'")


def downgrade() -> None:
    """Nothing: an enum value cannot be dropped in place, and the rows are user content (see above)."""
