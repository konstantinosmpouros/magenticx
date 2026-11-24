"""The composer queue holds several messages: conversations.queued_message -> queued_messages

Revision ID: 0053_queued_messages_list
Revises: 0052_message_kind_interjection
Create Date: 2026-11-24

The composer used to hold one queued message (a second send replaced it). It
now holds a short list, oldest first: the run reads the leading plain ones at
its next step (steering) or, when it ends, they go out stacked under one
answer (engine/inference/composer_queue.py).

The column is renamed and every held message kept: a stored object becomes a
one-item list, and it gets the per-message ``id`` the composer cancels it by.
No data is dropped.
"""
from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "0053_queued_messages_list"
down_revision: str | None = "0052_message_kind_interjection"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.alter_column("conversations", "queued_message", new_column_name="queued_messages")
    if op.get_bind().dialect.name == "postgresql":
        op.execute(
            """
            UPDATE conversations
               SET queued_messages = jsonb_build_array(
                       queued_messages || jsonb_build_object('id', gen_random_uuid()::text))
             WHERE jsonb_typeof(queued_messages) = 'object'
            """
        )


def downgrade() -> None:
    # Back to one slot: keep the oldest message of each queue (the others are
    # newer sends that the old code would have replaced anyway).
    if op.get_bind().dialect.name == "postgresql":
        op.execute(
            """
            UPDATE conversations
               SET queued_messages = queued_messages -> 0
             WHERE jsonb_typeof(queued_messages) = 'array'
            """
        )
    op.alter_column("conversations", "queued_messages", new_column_name="queued_message")
