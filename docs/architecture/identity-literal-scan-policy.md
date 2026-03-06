# Identity Literal Scan Policy

The repository enforces a fail-closed identity-literal scanner to prevent branded identity strings from re-entering runtime/authored paths.

Scanner command:

```bash
npm run verify:identity-literals
```

Repository hygiene command:

```bash
npm run verify:repository-hygiene
```

## Scope

The scanner (`scripts/identity-literal-scan.mjs`) scans tracked files under:

- `src/`
- `admin-ui/src/`
- `scripts/`

It excludes:

- test/spec files and `__tests__` folders
- binary/non-text artifacts
- generated/runtime dirs such as `dist/`, `node_modules/`, `.beads/`, `data/`, `logs/`, `workspace/`, `history/`

This keeps enforcement strict on production/runtime-authored sources while avoiding fixture noise.

## Exception Policy

Exceptions are explicit and file-local in:

- `config/identity-literal-scan-allowlist.json`

Each allowlist entry must include:

- `path`: repository-relative file path
- `contains`: exact line fragment that is intentionally exempted
- `reason`: why the exemption exists
- optional `pattern`: scanner pattern name when exemption must apply to only one rule

Example entry:

```json
{
  "path": "src/identity/loader.ts",
  "contains": "LEGACY_BOOTSTRAP_NAME = 'Purrsephone'",
  "reason": "Legacy bootstrap identity migration marker."
}
```

## Review Rules

When adding or modifying allowlist entries:

1. Prefer removing the literal instead of allowlisting it.
2. If allowlisting is required, keep the `contains` match as narrow as possible.
3. Add/update tests proving violations are blocked and only specific exceptions are suppressed.
4. Include migration/follow-up context in the `reason` so exemptions are auditable.
