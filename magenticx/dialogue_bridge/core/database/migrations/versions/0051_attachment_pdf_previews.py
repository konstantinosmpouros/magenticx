"""PDF previews of Office attachments: attachment_pdf_previews

Revision ID: 0051_attachment_pdf_previews
Revises: 0050_message_canvas_edit
Create Date: 2026-11-19

Plan 44 (canvas, Phase 4.5): a .docx / .xlsx / .pptx attachment is previewed
as a PDF that LibreOffice renders in the sandbox box. The rendering is cached
here: one row per attachment it was made for, looked up by the source bytes'
SHA-256 within the user's own attachments, deleted with the attachment
(``ON DELETE CASCADE``).

Additive only: one new table.
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0051_attachment_pdf_previews"
down_revision: str | None = "0050_message_canvas_edit"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "attachment_pdf_previews",
        sa.Column("attachment_id", sa.String(), nullable=False),
        sa.Column("source_sha256", sa.String(length=64), nullable=False),
        sa.Column("data", sa.LargeBinary(), nullable=False),
        sa.Column("size_bytes", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["attachment_id"], ["attachments.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("attachment_id"),
    )
    op.create_index(
        op.f("ix_attachment_pdf_previews_source_sha256"), "attachment_pdf_previews", ["source_sha256"]
    )


def downgrade() -> None:
    op.drop_index(op.f("ix_attachment_pdf_previews_source_sha256"), table_name="attachment_pdf_previews")
    op.drop_table("attachment_pdf_previews")
