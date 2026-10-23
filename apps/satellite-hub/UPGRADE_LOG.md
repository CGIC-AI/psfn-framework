# Dependency Upgrade Log

**Date:** 2026-10-23
**Project:** PSFN Satellite Hub
**Language:** Python
**Manifest:** `pyproject.toml`; resolved packages in `uv.lock`

## Summary

| Metric | Count |
| --- | --- |
| Affected dependencies | 7 |
| Updated | 7 |
| Required companion resolutions | 1 |
| Skipped | 0 |
| Failed (rolled back) | 0 |
| Requires attention | 0 |

Scope: the seven packages with fixable advisories in the pinned OSV-Scanner
2.4.0 scan, plus AnyIO's required typing-extensions resolution. Other packages
retain their existing resolutions. Python `>=3.11` remains supported.

## Successfully Updated

### anyio: 4.12.1 → 4.15.1

**Changelog:** [Tagged source](https://github.com/agronholm/anyio/blob/4.15.1/docs/versionhistory.rst)
(`ffcd1542cd6d127980205f90a0100078849dd703`, released 2026-09-05).

**Breaking changes:** Python minimum is 3.10; task-group methods gain return
handles, some callable annotations narrow, synchronization objects gain slots,
and byte-stream reads reject nonpositive sizes. Hub uses AnyIO's pytest plugin
and its HTTP dependency stack, without directly using those changed APIs.
Version 4.15.1 fixes submodule access after lazy imports.

**Notable changes:** IDNA 2008 TLS hostname validation, cancellation and process
cleanup fixes. Its tagged manifest requires `typing-extensions>=4.16.0` below
Python 3.15, so the resolver necessarily updates 4.15.0 → 4.16.0 alongside AnyIO.
The [typing-extensions tagged changelog](https://github.com/python/typing_extensions/blob/4.16.0/CHANGELOG.md)
(`f29cd28d8ed7642cafb1d18daf5aa41be6a5c0aa`) documents protocol/typing fixes,
sentinel API deprecations, and Python 3.15 support. Hub has no direct use of
the affected typing APIs. PyPI dates the final 4.16.0 artifacts to 2026-07-02;
the changelog's 2025 heading is inconsistent with its June 2026 RC entries.

**Deprecations fixed:** None needed.

**Tests:** Frozen sync and all 61 Python tests passed (0.96s); no runtime edits.

### certifi: 2026.2.25 → 2026.10.19

**Changelog:** [Release source commit](https://github.com/certifi/python-certifi/commit/662df63d7906df66f1f07c0751a3dfe9da14d914)
(published to PyPI 2026-10-20).

**Breaking changes:** The CA bundle changes trust anchors; TLS connections to
chains relying on removed roots will fail validation. Python minimum is 3.7.
The `where()` API is unchanged. No custom CA workaround is added.

**Notable changes:** Updated Mozilla trust store, including the emSign root
correction in the selected stable release.

**Deprecations fixed:** None needed.

**Tests:** Frozen sync and all 61 Python tests passed; no runtime edits.

### cryptography: 46.0.5 → 50.0.2

**Changelog:** [Tagged source](https://github.com/pyca/cryptography/blob/50.0.2/CHANGELOG.rst)
(`4dda5c7fe4ae71b8925f2551910a0ef959df9c7a`, released 2026-09-30).

**Breaking changes:** Python minimum rises to 3.9; source builds need OpenSSL
3.0+ and Rust 1.83+. Binary curves, deprecated key type aliases and older cipher
exports are removed. Key/certificate parsing rejects additional invalid
encodings, and unsupported key algorithms now raise `UnsupportedAlgorithm`.
Version 49 removes Intel macOS and 32-bit Windows support/wheels. These upstream
platform changes remain a deployment limitation outside the Linux validation.

**Notable changes:** PKCS7 decryption oracle fix; current wheels bundle OpenSSL
4.0.3. Hub uses the preserved Ed25519 and serialization APIs; inspection of the
installed Noise/ChaCha20-Poly1305 adapters found no removed cipher APIs.

**Deprecations fixed:** None needed; no finite-field DH usage in Hub code.

**Tests:** Frozen sync and all 61 Python tests passed, including device assertion
signing and enrollment validation; no runtime edits.

### idna: 3.11 → 3.20

**Changelog:** [Tagged source](https://github.com/kjd/idna/blob/v3.20/HISTORY.md)
(`d55e65e1a3b1ede7f556bc202738066f5597e249`, released 2026-09-17).

**Breaking changes:** Python minimum is 3.9. Domain validation caps input at
1024 characters, rejects oversized labels and noncanonical A-labels, restores
STD3 handling, and updates Unicode tables to 18.0. The transitional argument is
deprecated/ignored. Hub does not call IDNA directly; HTTPX uses it transitively.

**Notable changes:** Closes the quadratic-time input-processing bypass
CVE-2026-45409 and enforces domain length in the incremental codec.

**Deprecations fixed:** None needed.

**Tests:** Frozen sync and all 61 Python tests passed; no runtime edits.

### pygments: 2.19.2 → 2.21.0

**Changelog:** [Tagged source](https://github.com/pygments/pygments/blob/2.21.0/CHANGES)
(`a43b45dcf081b6010c6ab4428f149f7f6d2499c4`, released 2026-08-17).

**Breaking changes:** Python minimum rises to 3.9; the Coq lexer is renamed to
Rocq and HTML formatter quoting changes. Hub uses Pygments through Rich/pytest,
without custom lexers or formatters, so no application migration is required.

**Notable changes:** Fixes catastrophic backtracking in several lexers and
`looks_like_xml`, plus a TableGen infinite loop.

**Deprecations fixed:** None needed.

**Tests:** Frozen sync and all 61 Python tests passed; no runtime edits.

### pytest: 8.4.2 → 9.1.1

**Changelog:** [Tagged source](https://github.com/pytest-dev/pytest/blob/9.1.1/doc/en/changelog.rst)
(`cf470ec0bf7eb89cd97dd56df4859eae5db46447`, released 2026-06-19).

**Breaking changes:** Python minimum is 3.10; pytest 9 changes overlapping
collection argument handling, treats deprecated pytest 9 APIs as errors, and
changes some private fixture/configuration internals. Hub uses public fixtures
and one configured test directory, without the removed APIs or doctest setup.

**Notable changes:** Fixture scoping/teardown corrections; 9.1.1 repairs 9.1.0
fixture parametrization and initial-conftest regressions.

**Deprecations fixed:** None needed; no warning suppression added.

**Tests:** Frozen sync and all 61 Python tests passed under pytest 9.1.1;
no runtime or test compatibility edits.

### zeroconf: 0.148.0 → 0.151.5

**Changelog:** [Tagged source](https://github.com/python-zeroconf/python-zeroconf/blob/0.151.5/CHANGELOG.md)
(`f8b9ac54e772672f879bc81f02d552f9575bf7ba`, released 2026-09-28).

**Breaking changes:** Python minimum is 3.10; Intel macOS wheels are removed.
Service resolution now requires TXT records and handles NSEC denials strictly.
The aioesphomeapi dependency permits this release without changing its pin.

**Notable changes:** Bounds DNS cache, question history, duplicate packet
tracking, deferred queues and record parsing against LAN-driven resource
exhaustion; fixes owned event-loop/socket cleanup and Cython packaging.

**Deprecations fixed:** None needed.

**Tests:** Frozen sync and all 61 Python tests passed, including ESPHome session
contracts; no runtime edits. Live multicast hardware validation is outside scope.

## Skipped

None within the advisory remediation scope.

## Failed Updates (Rolled Back)

None.

## Requires Attention

None.

## Deprecation Warnings Fixed

None.

## Security Notes

The baseline pinned direct `uv.lock` scan exits 1 with 17 fixable advisories.
The repository wrapper previously covered five npm lockfiles; it now includes
this uv lockfile and both relay NuGet lockfiles from the coordinated relay fix.
Any missing owned lockfile fails before the scanner version probe.

The final pinned direct `uv.lock` scan exits 0, scans all 36 resolved packages,
and returns an empty `results` array. It uses the repository's immutable image
`ghcr.io/google/osv-scanner@sha256:bcb04b6bab5ab578898b3ff8b81b381e7961b1eac6aa87639b53aaea0d266003`.
No advisories are ignored. The online feed is authoritative as of this check;
future advisory additions can change that verdict.

| Package | Resolved advisory identifiers (aliases grouped by OSV) |
| --- | --- |
| anyio | GHSA-5p39-cfhj-2xmp, GHSA-82r6-8w77-94w6 |
| certifi | GHSA-6q48-6c7w-9gw2 |
| cryptography | GHSA-m959-cc7f-wv43, GHSA-g6cj-pr64-35w5, GHSA-jwv3-5hgf-82ww, GHSA-m2h6-j472-rp4c, GHSA-p423-j2cm-9vmq, GHSA-537c-gmf6-5ccf |
| idna | GHSA-65pc-fj4g-8rjx |
| pygments | GHSA-5239-wwwm-4pmq |
| pytest | GHSA-6w46-j5rx-g56g |
| zeroconf | GHSA-9663-mqmp-p9mm, GHSA-9pgc-3ccv-5297, GHSA-phvx-9mgw-67r5, GHSA-qc2x-6f54-m6h9, GHSA-rfg2-pjw2-56x2 |

## Final Validation

- `npm run verify:satellite-hub`: TypeScript typecheck/build, 356 TypeScript
  tests and 61 Python tests pass on CPython 3.13.2.
- Separate Python 3.11.15 frozen environment: all 61 tests pass with `-W error`.
- `uv build --project apps/satellite-hub`: source distribution and wheel build.
- Scanner and local-gate routing regressions: all 53 tests pass, including
  explicit uv/NuGet arguments, read-only mounting, immutable image pin, version
  verification, findings/error propagation and every missing-lockfile case.
- Changed-file lint, public sanitation (including local privacy rules), and
  `git diff --check` pass.
- The complete eight-lockfile wrapper requires the two committed NuGet locks
  from the coordinated relay change; integrated scan evidence is recorded on
  the owning bead after that change is available.

## Post-Upgrade Checklist

- [x] All tests passing
- [x] No new Python deprecation warnings (`-W error` on Python 3.11)
- [x] Package build performed
- [x] Scanner contract and routing updated
- [x] Changes committed as the dependency/scanner worker checkpoint

## Commands Used

```bash
uv lock --project apps/satellite-hub --upgrade-package anyio==4.15.1
uv lock --project apps/satellite-hub --upgrade-package certifi==2026.10.19
# After editing the direct cryptography pin:
uv lock --project apps/satellite-hub --upgrade-package cryptography==50.0.2
uv lock --project apps/satellite-hub --upgrade-package idna==3.20
uv lock --project apps/satellite-hub --upgrade-package pygments==2.21.0
# After editing the direct pytest pin:
uv lock --project apps/satellite-hub --upgrade-package pytest==9.1.1
uv lock --project apps/satellite-hub --upgrade-package zeroconf==0.151.5
# Sync and Python tests were run after each individual resolution:
uv sync --project apps/satellite-hub --frozen --group dev
uv run --project apps/satellite-hub --frozen pytest -q apps/satellite-hub/tests
npm run verify:satellite-hub
UV_PROJECT_ENVIRONMENT=/tmp/psfn-python-deps-venv311 uv sync --project apps/satellite-hub --frozen --group dev --python 3.11
UV_PROJECT_ENVIRONMENT=/tmp/psfn-python-deps-venv311 uv run --project apps/satellite-hub --frozen --python 3.11 pytest -q -W error apps/satellite-hub/tests
uv build --project apps/satellite-hub
node --test scripts/ci/run-osv-scan.test.mjs scripts/ci/local-delivery-contract.test.mjs
npm run lint:changed -- --base 1f68d6ce1
npm run verify:public-sanitize
docker run --rm --platform linux/amd64 --volume "$PWD:/repo:ro" --workdir /repo ghcr.io/google/osv-scanner@sha256:bcb04b6bab5ab578898b3ff8b81b381e7961b1eac6aa87639b53aaea0d266003 --format=json --lockfile=/repo/apps/satellite-hub/uv.lock
node scripts/ci/run-osv-scan.mjs --format=json
```

## Notes

Only direct advisory fixes change manifest pins. Transitive updates use targeted
`uv lock --upgrade-package` resolution. No suppressions or prereleases are used.
The final repository pre-PR gate belongs to the integration owner and is not
run on this worker checkpoint. Hardware, live-provider and non-Linux platform
validation are outside this dependency-only change. npm emits the existing
unknown `onnxruntime-node-install-cuda` configuration warning; no new Python
deprecation warnings are present.
