"""The virtual path a presented file came from: attachments.source_path

Revision ID: 0049_attachment_source_path
Revises: 0048_message_effort
Create Date: 2026-11-18

Plan 44 (canvas, Phase 4.1): a presented ``.md`` file is a canvas document,
whose versions the agents service keys by the path the agent presented it
from (``/conversation/output/brief.md``). The run-end capture now records that
path on the generated attachment, so the card can open the right document even
when the file sits in a subfolder of output/.

Additive only: one nullable column. Older rows and uploads stay NULL; the UI
falls back to ``/conversation/output/<file name>`` for them.
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0049_attachment_source_path"
down_revision: str | None = "0048_message_effort"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("attachments", sa.Column("source_path", sa.String(length=1024), nullable=True))


def downgrade() -> None:
    op.drop_column("attachments", "source_path")
