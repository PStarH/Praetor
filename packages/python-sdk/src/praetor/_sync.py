"""Synchronous wrapper for CommanderClient.

⚠️  Not for Jupyter/notebooks — use ``CommanderClient`` with ``asyncio.run()`` there.
"""

from __future__ import annotations

import asyncio
import inspect
from typing import Any

from ._client import CommanderClient as _CommanderClient


def _make_sync_method(name: str):
    """Create a synchronous wrapper for an async CommanderClient method."""

    def _sync_method(self: CommanderClientSync, *args: Any, **kwargs: Any) -> Any:
        return asyncio.run(getattr(self._get_client(), name)(*args, **kwargs))

    # Copy docstring and signature metadata for better introspection.
    async_method = getattr(_CommanderClient, name)
    _sync_method.__doc__ = async_method.__doc__
    _sync_method.__name__ = name
    return _sync_method


def _attach_sync_methods(
    cls: type[CommanderClientSync],
) -> type[CommanderClientSync]:
    """Attach sync wrappers for every public async method on CommanderClient."""
    skip = {"close", "__aenter__", "__aexit__"}
    for name, method in inspect.getmembers(
        _CommanderClient, predicate=inspect.isfunction
    ):
        if name.startswith("_") or name in skip:
            continue
        if inspect.iscoroutinefunction(method):
            setattr(cls, name, _make_sync_method(name))
    return cls


@_attach_sync_methods
class CommanderClientSync:
    """Synchronous Commander client for scripts and simple automation.

    Usage::

        client = CommanderClientSync(api_key="cmd-...")
        result = client.run("analyze this")
        plan = client.plan("audit repo")
        client.close()
    """

    def __init__(self, **kwargs: Any) -> None:
        self._kwargs = kwargs
        self._client: _CommanderClient | None = None

    def _get_client(self) -> _CommanderClient:
        if self._client is None:
            self._client = _CommanderClient(**self._kwargs)
        return self._client

    def close(self) -> None:
        if self._client is not None:
            asyncio.run(self._client.close())

    def __getattr__(self, name: str) -> Any:
        """Proxy synchronous attributes (e.g. agents, tasks, properties) to the async client."""
        if name.startswith("_"):
            raise AttributeError(name)
        return getattr(self._get_client(), name)


# Canonical PraetorClientSync alias
PraetorClientSync = CommanderClientSync

