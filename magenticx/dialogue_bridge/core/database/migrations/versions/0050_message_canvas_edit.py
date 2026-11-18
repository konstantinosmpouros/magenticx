"""The canvas passage a user message asks the agent to change: messages.canvas_edit

Revision ID: 0050_message_canvas_edit
Revises: 0049_attachment_source_path
Create Date: 2026-11-18

Plan 44, Phase 4.3. "Ask agent" on a selection in the canvas (and its presets,
"Make it shorter" ...) sends a user message whose visible content is the
instruction, plus the passage it is about: the document's path, the version the
selection was made on, the selected text, the headings above it, the
instruction and the preset. The user message keeps that here, like ``command``
(0040), so the run context carries it, a retry asks for the same change, and
the bubble can show the quoted passage after a reload. NULL on every other
message.

Additive only: one nullable JSON column. Nothing to backfill.
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0050_message_canvas_edit"
down_revision: str | None = "0049_attachment_source_path"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("messages", sa.Column("canvas_edit", sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column("messages", "canvas_edit")
