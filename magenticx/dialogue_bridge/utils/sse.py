"""Server-Sent Events helpers: read an SSE byte stream, and write one.

Generic on purpose (no knowledge of runs or Redis): the bridge parses the
agents service's SSE stream with :func:`parse_sse_bytes`, and serves its own
streams to the browser with :func:`format_sse` and :func:`with_heartbeat`
(:func:`frames_to_sse` puts the two together for a stream of JSON frames).
"""

import asyncio
import json
from typing import Any, AsyncIterator

# The SSE comment a quiet stream sends so no proxy (nginx, NPM, Cloudflare's
# ~100 s idle cut-off) closes it while a run thinks.
HEARTBEAT_COMMENT = b": ping\n\n"

# Response headers every browser-facing SSE stream carries:
# - `no-transform` stops intermediaries (Cloudflare) from compressing the body,
#   and compression buffers — tokens would arrive in bursts;
# - `X-Accel-Buffering: no` turns buffering off in any nginx on the way (our
#   agentic_ui and Nginx Proxy Manager in front of it).
SSE_RESPONSE_HEADERS = {
    "Cache-Control": "no-cache, no-transform",
    "X-Accel-Buffering": "no",
}


def parse_sse_bytes(buffer: str, chunk: bytes) -> tuple[str, list[dict[str, Any]]]:
    """Append ``chunk`` to ``buffer`` and return ``(rest, events)``: the JSON
    ``data`` of every complete event, and what is left of an incomplete one."""
    buffer += chunk.decode("utf-8", errors="ignore")
    events: list[dict[str, Any]] = []
    while "\n\n" in buffer:
        raw_event, buffer = buffer.split("\n\n", 1)
        data_lines = []
        for line in raw_event.splitlines():
            stripped = line.strip()
            if stripped.startswith("data:"):
                data_lines.append(stripped[5:].strip())
        if not data_lines:
            continue
        payload = "\n".join(data_lines).strip()
        if not payload:
            continue
        try:
            value = json.loads(payload)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict) and value.get("type"):
            events.append(value)
    return buffer, events


def format_sse(data: Any, *, event: str | None = None, event_id: str | None = None) -> bytes:
    """One SSE event: optional ``id:`` and ``event:`` lines, then ``data:`` as
    compact JSON on a single line (``json.dumps`` escapes any newline inside a
    string, so the event can never be split early)."""
    lines: list[str] = []
    if event_id:
        lines.append(f"id: {event_id}")
    if event:
        lines.append(f"event: {event}")
    lines.append("data: " + json.dumps(data, ensure_ascii=False, separators=(",", ":")))
    return ("\n".join(lines) + "\n\n").encode("utf-8")


async def with_heartbeat(
    source: AsyncIterator[bytes],
    interval_seconds: float,
    comment: bytes = HEARTBEAT_COMMENT,
) -> AsyncIterator[bytes]:
    """Pass ``source``'s chunks through, adding ``comment`` whenever it has
    been quiet for ``interval_seconds``.

    No buffer in between: the next chunk is awaited as one pending task, and a
    timeout only interleaves a comment while that same task keeps waiting —
    so the source is read exactly as fast as the client takes chunks (a slow
    client reads behind, it never drops or piles up frames), and the source is
    never cancelled mid-read by the heartbeat. On exit (the stream ended, or the
    client left and the response was cancelled) the pending read is cancelled
    and the source closed.
    """
    iterator = source.__aiter__()
    pending: asyncio.Future[bytes] | None = None
    try:
        while True:
            if pending is None:
                pending = asyncio.ensure_future(iterator.__anext__())
            done, _ = await asyncio.wait({pending}, timeout=interval_seconds)
            if not done:
                yield comment
                continue
            finished, pending = pending, None
            try:
                chunk = finished.result()
            except StopAsyncIteration:
                return
            yield chunk
    finally:
        if pending is not None and not pending.done():
            pending.cancel()
            await asyncio.gather(pending, return_exceptions=True)
        aclose = getattr(iterator, "aclose", None)
        if aclose is not None:
            try:
                await aclose()
            except RuntimeError:
                # Already finished or closed by the cancellation above.
                pass


async def _frames_as_events(frames: AsyncIterator[dict[str, Any]]) -> AsyncIterator[bytes]:
    """One SSE event per frame: ``event:`` is the frame's ``type``, ``id:`` its
    ``seq`` when it has one, and ``data:`` the whole frame unchanged."""
    async for frame in frames:
        seq = frame.get("seq")
        yield format_sse(
            frame,
            event=str(frame.get("type") or "message"),
            event_id=seq if isinstance(seq, str) else None,
        )


def frames_to_sse(frames: AsyncIterator[dict[str, Any]], heartbeat_seconds: float) -> AsyncIterator[bytes]:
    """Serve a stream of JSON frames over SSE, each frame one event
    (unchanged as its data), with a heartbeat while it is quiet.

    The frame's ``seq`` becomes the event ``id``, so a reconnecting client can
    resume with ``Last-Event-ID`` (or ``?since=``) like it would with a
    ``subscribe {since}``.
    """
    return with_heartbeat(_frames_as_events(frames), heartbeat_seconds)
