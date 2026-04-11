# Satellites

Embodied or remote endpoint packages live here.

Each satellite owns its host-side runtime code plus any endpoint, protocol,
shared, or deploy assets that belong to that embodied surface.

Current package shape:

- `host/` for runtime-side routing and adapters
- `endpoint/` for endpoint/device-side code
- `protocol/` for satellite-specific protocol definitions
- `shared/` for helpers shared within the satellite package
- `deploy/` for deployment assets owned by the satellite

Transport-only channels stay under `src/channels`.
