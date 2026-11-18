"""The Artifacts page's listing: every file of one user, across conversations (plan 44).

One keyset-paginated query over ``attachments`` joined to their message and
conversation, scoped to the caller. It returns metadata only — never a byte of
content: the bytes stay behind the existing download / preview routes and their
own ownership checks, so this listing cannot become a second way to read a file.

What a row is:

- **input**: an upload (``origin = "upload"``), a file the user attached;
- **output**: a generated file (``origin = "generated"``), i.e. a snapshot the
  agent presented (``utils/output_capture.py``).

What is left out, on purpose:

- private (incognito) chats and "Try it" trials — every list in the app hides
  them (sidebar, search, Usage), and the files of a chat that leaves no trace
  must not reappear here;
- rows without a blob — there is nothing to download or preview;
- deleted conversations and messages — deletes are hard (rows and their
  attachments cascade away), so a deleted item simply has no row to join.

The file *type* (doc, sheet, slides, pdf, image, text, other) is derived from
the MIME type or, failing that, the file extension, with one ordered rule list
used both to filter in SQL and to label each row in Python, so a filter never
disagrees with the label it shows.
"""
from __future__ import annotations

import base64
import binascii
import json
import re
from datetime import datetime
from typing import Any, Optional

from fastapi import HTTPException, status
from sqlalchemy import ColumnElement, and_, false, func, not_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from core.database import AttachmentTable, ConversationTable, MessageTable
from schema import UserFileOut, UserFilesPage

# Which file types exist, and in which order a file is tested against them: the
# first rule that matches names it ("text/csv" is a sheet, not text). "other"
# is what matches none.
FILE_TYPES: tuple[str, ...] = ("pdf", "doc", "sheet", "slides", "image", "text", "other")

# rule → (exact MIME types, MIME prefixes, file extensions). Lowercase.
_TYPE_RULES: dict[str, tuple[frozenset[str], tuple[str, ...], frozenset[str]]] = {
    "pdf": (frozenset({"application/pdf"}), (), frozenset({"pdf"})),
    "doc": (
        frozenset({
            "application/msword",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "application/vnd.oasis.opendocument.text",
            "application/rtf",
            "text/rtf",
        }),
        (),
        frozenset({"doc", "docx", "odt", "rtf"}),
    ),
    "sheet": (
        frozenset({
            "application/vnd.ms-excel",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "application/vnd.ms-excel.sheet.macroenabled.12",
            "application/vnd.oasis.opendocument.spreadsheet",
            "text/csv",
            "text/tab-separated-values",
        }),
        (),
        frozenset({"xls", "xlsx", "xlsm", "ods", "csv", "tsv"}),
    ),
    "slides": (
        frozenset({
            "application/vnd.ms-powerpoint",
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            "application/vnd.oasis.opendocument.presentation",
        }),
        (),
        frozenset({"ppt", "pptx", "odp"}),
    ),
    "image": (frozenset(), ("image/",), frozenset({"png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"})),
    "text": (
        frozenset({"application/json", "application/xml", "application/x-yaml", "application/yaml"}),
        ("text/",),
        frozenset({"txt", "md", "markdown", "json", "xml", "yaml", "yml", "log", "html", "py", "js", "ts", "sql"}),
    ),
}

KINDS: tuple[str, ...] = ("input", "output")
_ORIGIN_BY_KIND = {"input": "upload", "output": "generated"}

_ROW_ID = re.compile(r"^[A-Za-z0-9-]{1,64}$")
_MAX_CURSOR_LENGTH = 512


def _extension(file_name: str) -> str:
    """The lowercase extension of a file name, or "" when it has none."""
    name = (file_name or "").strip().lower()
    return name.rsplit(".", 1)[-1] if "." in name else ""


def classify_file_type(mime_type: str | None, file_name: str | None) -> str:
    """The display type of one file — the first rule that matches, else "other"."""
    mime = (mime_type or "").split(";")[0].strip().lower()
    ext = _extension(file_name or "")
    for file_type, (mimes, prefixes, exts) in _TYPE_RULES.items():
        if mime in mimes or (prefixes and mime.startswith(prefixes)) or ext in exts:
            return file_type
    return "other"


def _rule_matches(file_type: str) -> ColumnElement[bool]:
    """SQL twin of one rule in :func:`classify_file_type`."""
    mimes, prefixes, exts = _TYPE_RULES[file_type]
    mime = func.lower(AttachmentTable.mime_type)
    name = func.lower(AttachmentTable.file_name)
    clauses: list[ColumnElement[bool]] = []
    if mimes:
        clauses.append(mime.in_(sorted(mimes)))
    clauses.extend(mime.like(f"{prefix}%") for prefix in prefixes)
    clauses.extend(name.like(f"%.{ext}") for ext in sorted(exts))
    return or_(*clauses) if clauses else false()


def _type_filter(file_type: str) -> ColumnElement[bool]:
    """Rows whose *first* matching rule is ``file_type`` — the same precedence as
    :func:`classify_file_type`, so the filter and the row's label agree."""
    ordered = [t for t in FILE_TYPES if t != "other"]
    if file_type == "other":
        return not_(or_(*(_rule_matches(t) for t in ordered)))
    earlier = ordered[: ordered.index(file_type)]
    match = _rule_matches(file_type)
    if not earlier:
        return match
    return and_(match, not_(or_(*(_rule_matches(t) for t in earlier))))


def _invalid_cursor() -> HTTPException:
    return HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid cursor.")


def _encode_cursor(created_at: datetime, row_id: str) -> str:
    raw = json.dumps({"t": created_at.isoformat(), "i": row_id}, separators=(",", ":")).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _decode_cursor(cursor: str) -> tuple[datetime, str]:
    """An opaque keyset cursor back into (created_at, attachment id).

    Not signed: it only narrows the caller's own, already-scoped rows, so a
    forged one can do no more than page their own list oddly. Every field is
    still validated, so a malformed cursor is a 400, never a query error.
    """
    if len(cursor) > _MAX_CURSOR_LENGTH:
        raise _invalid_cursor()
    try:
        data = json.loads(base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)))
    except (binascii.Error, ValueError) as exc:
        raise _invalid_cursor() from exc
    if not isinstance(data, dict):
        raise _invalid_cursor()
    stamp, row_id = data.get("t"), data.get("i")
    if not isinstance(row_id, str) or not _ROW_ID.match(row_id) or not isinstance(stamp, str):
        raise _invalid_cursor()
    try:
        return datetime.fromisoformat(stamp), row_id
    except ValueError as exc:
        raise _invalid_cursor() from exc


def _like_pattern(query: str) -> str:
    """A case-insensitive substring pattern with LIKE's wildcards escaped."""
    escaped = query.lower().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


async def list_user_files(
    db: AsyncSession,
    user_id: str,
    *,
    kind: Optional[str],
    file_type: Optional[str],
    query: Optional[str],
    cursor: Optional[str],
    limit: int,
) -> UserFilesPage:
    """One keyset page of the user's files, newest first (``created_at``, then id).

    ``kind``/``file_type`` are already validated by the router's ``Literal``s;
    ``query`` is a filename substring, matched case-insensitively.
    """
    att = AttachmentTable
    conv = ConversationTable
    stmt = (
        select(
            att.id,
            att.blob_id,
            att.file_name,
            att.mime_type,
            att.size_bytes,
            att.origin,
            att.presented,
            att.title,
            att.summary,
            att.source_path,
            att.created_at,
            att.message_id,
            conv.id.label("conversation_id"),
            conv.title.label("conversation_title"),
        )
        .join(MessageTable, MessageTable.id == att.message_id)
        .join(conv, conv.id == MessageTable.conversation_id)
        .where(
            conv.user_id == user_id,
            conv.is_private.is_(False),
            conv.is_trial.is_(False),
            att.blob_id.is_not(None),
        )
    )
    if kind:
        stmt = stmt.where(att.origin == _ORIGIN_BY_KIND[kind])
    if file_type:
        stmt = stmt.where(_type_filter(file_type))
    if query:
        stmt = stmt.where(func.lower(att.file_name).like(_like_pattern(query), escape="\\"))
    if cursor:
        after_at, after_id = _decode_cursor(cursor)
        stmt = stmt.where(
            or_(att.created_at < after_at, and_(att.created_at == after_at, att.id < after_id))
        )
    stmt = stmt.order_by(att.created_at.desc(), att.id.desc()).limit(limit + 1)

    rows = (await db.execute(stmt)).all()
    has_more = len(rows) > limit
    rows = rows[:limit]
    items = [_row_to_item(r) for r in rows]
    next_cursor = _encode_cursor(rows[-1].created_at, rows[-1].id) if has_more and rows else None
    return UserFilesPage(items=items, nextCursor=next_cursor)


def _row_to_item(r: Any) -> UserFileOut:
    """One listing row as its response item."""
    return UserFileOut(
        attachmentId=r.id,
        blobId=r.blob_id,
        fileName=r.file_name,
        mime=r.mime_type,
        size=r.size_bytes,
        kind="input" if r.origin == "upload" else "output",
        type=classify_file_type(r.mime_type, r.file_name),
        conversationId=r.conversation_id,
        conversationTitle=r.conversation_title,
        messageId=r.message_id,
        createdAt=r.created_at,
        presented=bool(r.presented),
        title=r.title,
        summary=r.summary,
        sourcePath=r.source_path,
    )
