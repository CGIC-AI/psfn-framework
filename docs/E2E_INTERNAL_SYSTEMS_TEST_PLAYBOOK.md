# PSFN Internal Systems E2E Test Playbook

This playbook is for live validation against a running PSFN stack. It is intentionally manual/conversational, so we validate real tool routing through the substrate instead of only unit tests.

## Scope

- Validate end-to-end tool use through the live agent loop.
- Validate gateway-backed REPL capabilities (Band C).
- Validate memory/session persistence and basic runtime mutability.
- Validate Wyoming MVP contract checks for Voice PE/HA operator flow.
- Capture artifacts so a second reviewer can independently grade pass/fail.

## Required Runtime Mode

Use **gateway + agent** mode (not `npm run dev`) for full coverage.

Reason: `module_*`, `repo_*`, `crawler_fetch`, `web_research` in REPL require gateway RPC capabilities (`fs*`, `git*`, `web.fetch`) and gateway audit logs.

## Preflight

1. Set/confirm base model:
- `data/settings.json` should contain `"primaryModel": "moonshotai/kimi-k2"`.

2. Confirm endpoints:
- API: `http://127.0.0.1:3100/v1/chat/completions`
- Admin: `http://127.0.0.1:3001`

3. Confirm gateway audit DB path:
- Default: `data/gateway-audit.db`
- Override: `AUDIT_DB_PATH=/path/to/gateway-audit.db`

4. Keep the OpenRouter spec handy:
- `https://openrouter.ai/openapi.json`
- Reasoning tokens guidance: `https://openrouter.ai/docs/guides/best-practices/reasoning-tokens`

5. If you run the automated harness (`npm run e2e`) separately:
- It uses an isolated temp DB by default.
- Set `E2E_DATABASE_PATH` when you intentionally want a persistent DB path for inspection.

6. For Wyoming MVP validation:
- Review `docs/wyoming-mvp.md` for the Voice PE + Home Assistant matrix.
- Run the smoke harness once before manual Voice PE checks:
  - `npx tsx src/e2e-wyoming-roundtrip.ts`

7. For Discord DM + voice deployments:
- Run Discord readiness smoke in safe mode:
  - `npm run smoke:discord:dm-voice -- --dry-run --strict`
- If Discord credentials/channel IDs are available, run live read-only checks:
  - `npm run smoke:discord:dm-voice -- --live --strict --dm-channel-id <id> --voice-channel-id <id>`

## Logging Requirements

Capture all of the following:

- `logs/e2e/gateway.log`
- `logs/e2e/agent.log`
- `logs/e2e/transcript.md` (prompt + response pairs)
- `logs/e2e/gateway_audit.txt` (query output from the configured gateway audit DB path)
- `logs/e2e/artifact_snapshot.txt` (key file snapshots/checks)
- `logs/e2e/wyoming_smoke.txt` (captured output from `src/e2e-wyoming-roundtrip.ts`, when Wyoming MVP is in scope)

## Test Session Setup

- Use a fixed API session id, e.g. `X-Session-ID: e2e-internal`.
- Use fixed user identity:
  - `X-User-ID: vega`
  - `X-User-Name: V`
- REPL note:
  - Async tool calls in `think` are bounded by REPL execution timeout (`executionTimeoutMs`, default 5000ms).
  - If you see `Execution timed out after 5000ms`, treat it as budget/timeout behavior unless unexpected for the scenario.

## Test Cases

Use one turn per case (or a short two-turn exchange where noted). Ask explicitly for tool usage and a brief action report.

### T00 Model + baseline

Prompt:
- "State your current base model ID and confirm you can call tools in this substrate. Keep it to 2 lines."

Pass:
- Response returns normally and indicates tool capability awareness.

### T01 Memory write/read loop

Prompt:
- "Use `memory_write` to store: `E2E_MARKER_MEMORY_01: V likes jasmine tea at 9pm`. Then confirm by using `think` + `memory_search` and report exactly what you found."

Pass:
- Marker memory is written and later retrieved.

### T02 Memory batch import

Prompt:
- "Use `memory_import_batch` to import 2 memories tagged `e2e`: one semantic and one reflection. Then summarize import result counts."

Pass:
- Import succeeds with count > 0 and no schema errors.

### T03 Prompt stack read/update

Prompt:
- "Use prompt tools to list layers, then update one non-base/operator layer by appending `E2E_PROMPT_NOTE`. Confirm layer id and success."

Pass:
- Layer list returned.
- Update success reported.

### T04 Scheduler/heartbeat policy surface

Prompt:
- "Read heartbeat policy/settings and report current cadence. If an editable policy tool is available, make a no-op safe update and confirm."

Pass:
- Policy visibility confirmed.
- Optional update path confirmed.

### T05 REPL module registry APIs

Prompt:
- "Use `think` and call `module_install`, `module_list`, `module_health` for a tiny module named `e2e_probe`. Report enabled state and version."

Pass:
- Module operations succeed through REPL.
- Module appears in registry output.

### T06 REPL repo read operations

Prompt:
- "Use `think` and call `repo_status()` and `repo_diff(false)`. Return branch name and whether unstaged diff exists."

Pass:
- Repo status/diff results returned without policy rejection.

### T07 REPL repo write operation (safe docs patch)

Prompt:
- "Use `think` + `repo_apply_patch` to create or update `docs/e2e_runtime_probe.md` with one line containing current timestamp. Do not touch other files."

Pass:
- Patch apply returns success.
- File change appears in git status.

### T08 REPL crawler fetch

Prompt:
- "Use `think` + `crawler_fetch('https://example.com')` and return a 1-sentence summary."

Pass:
- Web fetch returns content through gateway path.

### T09 REPL web research

Prompt:
- "Use `think` + `web_research('Crawl4AI project overview', 2)` and return bullet list of the fetched URLs."

Pass:
- Returns at least one fetched URL/content block.

### T10 Crawl4AI skill install attempt (gap-closure probe)

Prompt:
- "Attempt to install skill from `https://docs.crawl4ai.com/assets/crawl4ai-skill.zip`, enable it, and use it to fetch one webpage. If unsupported, explain exactly which substrate capability is missing."

Pass:
- Either full success (install+use), or precise failure reason naming missing plumbing (skill package ingestion/adapter/runtime hook).

### T11 Settings mutation (admin path)

Action (admin endpoint/UI):
- Change a low-risk setting (example: `thinkMaxSubQueries`) and save.

Prompt:
- "Confirm current runtime setting value for `thinkMaxSubQueries`."

Pass:
- Saved value is reflected by runtime behavior/reporting.

### T12 L0 capture + reasoning trace sanity

Checks:
- Session JSONL includes turn history for `api:e2e-internal`.
- If reasoning traces are emitted, admin “Reasoning Traces” contains recent entries.

Pass:
- L0 session log present and append-only.
- Think trace visible when think tool was used.

### W00 Wyoming MVP smoke harness gate

Action:
- Run `npx tsx src/e2e-wyoming-roundtrip.ts`.

Pass:
- Harness exits successfully with:
  - `Failed: 0`
  - `PASS: Wyoming MVP round-trip and interruption smoke checks passed.`

### W01 Voice PE round-trip prompt (manual HA path)

Action:
- Use Voice PE in Home Assistant and say: `Status check alpha for kitchen satellite.`

Pass:
- Assist path returns a response tied to the same request phrase.
- Operator notes include `site_id` and `satellite_id` mapping used during test.

### W02 Voice PE interruption prompt (manual HA path)

Action:
- Say: `Read a long response so I can interrupt.`
- Interrupt with: `Stop.`

Pass:
- Existing response is interrupted/cancelled (no stale completion continuing after interruption).
- Observed behavior matches fallback policy documented in `docs/wyoming-mvp.md`.

## Post-Run Artifact Validation

1. Query gateway audit DB (at your configured `AUDIT_DB_PATH` or default path) for relevant methods:
- `git.status`, `git.diff`, `git.applyPatch`, `git.commit` (if used), `web.fetch`, `fs.read`, `fs.write`.

2. Snapshot:
- `purrsephone/modules/repl-registry.json`
- `data/settings.json`
- `data/sessions/api%3Ae2e-internal.jsonl` (or legacy filename if present)
- `git status --short`

3. Produce a final verdict table:
- `PASS` / `FAIL` / `PARTIAL` per test case with evidence links.

## Expected Known Gaps (if still unresolved)

- Skill ZIP ingestion/installation path may be absent even if REPL module APIs exist.
- Reasoning-token-specific persistence may require explicit provider payload handling; verify current behavior before claiming complete support.
