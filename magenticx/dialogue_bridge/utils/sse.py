"""Parse a Server-Sent Events byte stream into JSON event dicts."""

import json
from typing import Any


def parse_sse_bytes(buffer: str, chunk: bytes) -> tuple[str, list[dict[str, Any]]]:
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
