"""Async SSE stream parser for Commander's structured event format."""

from __future__ import annotations

import json
from collections.abc import AsyncGenerator

import httpx

from ._types import SSEEvent

# Sentinel sent by sseStream.ts.close()
_DONE_MARKER = "[DONE]"


class CommanderSSEStream:
    """Async generator that yields structured SSE events.

    Wire format (from ``sseStream.ts:emitStructured``)::

        id: {seq}
        event: {eventType}
        data: {"event":"{eventType}","data":{...},"timestamp":"ISO","seq":{n}}

    The ``data:`` field carries the full ``StructuredSSEEvent`` JSON envelope,
    **not** bare payload content.
    """

    def __init__(
        self,
        client: httpx.AsyncClient,
        session_id: str,
        base_url: str,
    ) -> None:
        # Prefer /api/v1/stream/{id}; fall back to /stream/runtime/{id}
        self._url = f"{base_url.rstrip('/')}/api/v1/stream/{session_id}"
        self._client = client

    async def __aiter__(self) -> AsyncGenerator[SSEEvent, None]:
        current_event: str | None = None
        async with self._client.stream("GET", self._url) as response:
            async for line in response.aiter_lines():
                if line.startswith((":", "id:")):
                    continue
                if line.startswith("event:"):
                    current_event = line[len("event:") :].strip()
                    continue
                if line.startswith("data:"):
                    raw = line[len("data:") :].strip()
                    if raw == _DONE_MARKER:
                        return
                    try:
                        envelope = json.loads(raw)
                    except json.JSONDecodeError:
                        continue
                    yield SSEEvent(
                        event=envelope.get("event", current_event),
                        data=envelope.get("data", {}),
                        timestamp=envelope.get("timestamp", ""),
                        seq=envelope.get("seq", 0),
                    )
                    continue
                # Empty line = end of event body
                current_event = None

    @staticmethod
    async def iter_from_response(
        response: httpx.Response,
    ) -> AsyncGenerator[SSEEvent, None]:
        """Parse SSE events from an already-open httpx streaming response.

        Used when the caller manages the HTTP lifecycle externally.
        """
        current_event: str | None = None
        async for line in response.aiter_lines():
            if line.startswith((":", "id:")):
                continue
            if line.startswith("event:"):
                current_event = line[len("event:") :].strip()
                continue
            if line.startswith("data:"):
                raw = line[len("data:") :].strip()
                if raw == _DONE_MARKER:
                    return
                try:
                    envelope = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                yield SSEEvent(
                    event=envelope.get("event", current_event),
                    data=envelope.get("data", {}),
                    timestamp=envelope.get("timestamp", ""),
                    seq=envelope.get("seq", 0),
                )
                continue
            current_event = None
