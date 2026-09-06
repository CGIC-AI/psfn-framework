"""PSFN provider entry point; loaded only when memory.provider selects psfn."""

from .provider import PSFNMemoryProvider


def register(ctx) -> None:
    ctx.register_memory_provider(PSFNMemoryProvider())
