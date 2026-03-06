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

Use `pattern` for every entry whenever possible to keep suppression narrow and prevent hiding unrelated identity-literal regressions on the same line.

Example entry:

```json
{
  "path": "src/identity/loader.ts",
  "contains": "LEGACY_BOOTSTRAP_NAME = 'Purrsephone'",
  "reason": "Legacy bootstrap identity migration marker.",
  "pattern": "identity-proper-name"
}
```

## Ownership And Update Process

When adding or modifying allowlist entries, the change owner must:

1. Prefer removing the literal instead of allowlisting it.
2. Keep `contains` as narrow as possible and include `pattern` unless no pattern-specific scoping is possible.
3. Add/update regression tests proving violations are blocked and only intended exceptions are suppressed.
4. Include migration/follow-up context in `reason` so exemptions remain auditable.
5. Run:
   - `npm test -- src/scripts/identity-literal-scan.test.ts src/scripts/identity-literal-gate.test.ts`
   - `npm run verify:identity-literals`

## Intentional Fixture Literals

Intentional literal coverage should be represented in scanner tests, not production/runtime modules.

- Prefer `.test.*` fixtures under `src/scripts/` because scanner scope excludes test/spec files.
- If a non-test source file must intentionally contain a literal for migration compatibility, add an explicit allowlist entry with:
  - exact `contains` fragment
  - `pattern`
  - auditable `reason`
- Do not add broad wildcard-like exceptions.
