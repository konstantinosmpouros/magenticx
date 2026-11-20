"""HTTP header helpers for the routes that serve files.

Two ``Content-Disposition`` builders, kept apart on purpose: they choose the
plain ``filename`` fallback differently, and the clients of each depend on it.

* ``encode_disposition`` (attachments, blobs, conversation PDFs) sanitises the
  name itself — slashes, backslashes and quotes replaced — and falls back to
  ``document.pdf`` / ``download`` when nothing ASCII is left.
* ``content_disposition`` (canvas exports, Office previews) takes a name the
  caller already validated, and falls back to ``document.<fmt>`` when the name
  is not ASCII.
"""
from urllib.parse import quote


def encode_disposition(name: str | None, disposition: str) -> str:
    fallback_name = "document.pdf" if disposition == "inline" else "download"
    safe_name = (name or fallback_name).replace("\\", "_").replace("/", "_").replace('"', "'").strip() or fallback_name
    ascii_name = safe_name.encode("ascii", "ignore").decode("ascii").strip() or fallback_name
    encoded_name = quote(safe_name)
    return f'{disposition}; filename="{ascii_name}"; filename*=UTF-8\'\'{encoded_name}'


def content_disposition(name: str, disposition: str, fmt: str) -> str:
    """``<disposition>; filename="<ascii>"; filename*=UTF-8''<name>``. The
    plain ``filename`` is for old clients: the name itself when it is ASCII,
    ``document.<fmt>`` otherwise (a Greek title would come out empty)."""
    ascii_name = name if name.isascii() else f"document.{fmt}"
    return f"{disposition}; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(name, safe='')}"
