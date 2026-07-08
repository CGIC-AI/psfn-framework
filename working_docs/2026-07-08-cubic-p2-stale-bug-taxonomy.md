# Cubic P2 Stale Bug Taxonomy - 2026-07-08

## Purpose

This document preserves the useful bug patterns from the old Cubic review P2 backlog while retiring the stale implementation beads.

Retired epic: `psfn-framework-qs83` - `Epic: Cubic review P2 validated findings`

Original source: `working_docs/cubic_review_findings_20260702.md`

Original review scope:

- Split PR stack: `#16` through `#28`
- Validation date: 2026-07-02
- Input P2 threads: 191
- Valid actionable P2 defects beaded then: 165
- Child range: `psfn-framework-qs83.1` through `psfn-framework-qs83.165`

Retirement reason:

The codebase has had a major update after the Cubic review and this old per-line backlog is now stale. Closing these beads is not a claim that each bug was fixed. It is an operator-directed stale/obsolete retirement of old review findings whose exact file/line premises should no longer drive current work. Future audits should use the taxonomy below to look for the same classes of defects against current code.

Method:

- Classified open P2/P3 bug children under `psfn-framework-qs83`.
- Matched 165 child bugs; all matched children were P2.
- Classification used issue titles as the primary signal to avoid overfitting to stale source file paths.
- Each issue is assigned one primary bucket. Many overlap; use cross-cutting judgment in future audits.

## Summary Counts

| Bug Type | Count |
|---|---:|
| Memory, retrieval, extraction, retention, profile, and social graph | 49 |
| Scheduler, fatigue, wakeup, outreach, and free-time | 20 |
| Privacy, security, path, secret, and audit | 15 |
| Prompt, macro, runtime context, and provider-message | 15 |
| Kubernetes, Helm, Redis, network, and deployment | 11 |
| Garden/admin/UI error mapping and stale fetch | 11 |
| Other review patterns | 11 |
| Tooling, provider, conformance, and health surfaces | 10 |
| Validation, normalization, parser, and default semantics | 7 |
| Persistence, migration, upsert, and data integrity | 6 |
| Async, race, restart, and stale state | 6 |
| Boundedness, pagination, caps, and unbounded work | 4 |
| Total | 165 |

## Future Audit Checklist

Use these as recurring bug-hunt lenses:

1. Check every async UI/admin fetch for stale-response guards and independent loading states.
2. Check every paginated or capped query for starvation, missed older/newer rows, and misleading metrics.
3. Check every JSON/config/parser boundary for malformed input, blank strings, nulls, inverted ranges, and prototype keys.
4. Check every migration/upsert for conflict keys, idempotence, sibling-worker cleanup, and fresh-install constraint parity.
5. Check every privacy/security path for secret leakage, path traversal, audit gaps, source attribution loss, and retired enum values exposed to callers.
6. Check prompt and macro machinery for conditional paths, stale cache inputs, volatile/session-stable boundary drift, and provider role labeling.
7. Check memory and social-graph systems for source attribution, retention/tag recomputation, stale review windows, and group-vs-private context leakage.
8. Check scheduler/fatigue/free-time systems for restart persistence, anti-loop scan windows, charge/fatigue cap consistency, and deterministic gates before LLM calls.
9. Check Kubernetes/chart/runtime ops for secret defaults, mounted-file assumptions, ExternalName/headless field conflicts, and selector ambiguity.
10. Check health and conformance surfaces for false positives, mislabeled failures, and optional dependency failures taking down whole pages.

## Bug Types

### Memory, Retrieval, Extraction, Retention, Profile, And Social Graph

Look for bugs where memory-like systems preserve the wrong source, apply stale metadata, skip necessary recomputation, or mix scopes.

Common shapes:

- source attribution or provenance is incomplete
- retention/durable tags are not recomputed after edits
- group/private context is mixed
- review windows scan the wrong end of a dataset
- stale fetches overwrite fresher local state
- profile and summary logic over- or under-counts evidence

Retired stale findings:

- `psfn-framework-qs83.2` - Companion delta payload is unbounded by entry count
- `psfn-framework-qs83.4` - Internal-state saves can race and regress snapshot
- `psfn-framework-qs83.5` - Arc duplicate check misses duplicates past default page limit
- `psfn-framework-qs83.6` - Discord queue bundling can skip earlier other-channel messages
- `psfn-framework-qs83.7` - Machine-intelligence flag update does not sync contact exports
- `psfn-framework-qs83.11` - Processing watermark upsert conflicts on id, not scope
- `psfn-framework-qs83.25` - Wiki document selection can commit stale fetch results
- `psfn-framework-qs83.26` - Wiki upsert can write self-invalid updatedBy metadata
- `psfn-framework-qs83.28` - Profile summaries can be falsely rejected for mentioning another named person
- `psfn-framework-qs83.29` - Durable memory normalization collapses arbitrary repeated capitalized names
- `psfn-framework-qs83.32` - Invalid wiki document ids are reported as HTTP 500
- `psfn-framework-qs83.43` - Blank numeric strings parse as zero for number-valued group-memory settings
- `psfn-framework-qs83.45` - Profile coverage status uses total attributed memories instead of source memories
- `psfn-framework-qs83.48` - Group-memory backfill service validation errors return HTTP 500
- `psfn-framework-qs83.53` - Observed extraction pending-age timer survives no-backlog clears
- `psfn-framework-qs83.57` - Zero-human group-capable channels can fall back to group mode
- `psfn-framework-qs83.60` - Episode detail race can show stale selected episode
- `psfn-framework-qs83.61` - Episode detail and thread fetch are coupled incorrectly
- `psfn-framework-qs83.63` - Emotion telemetry timestamp is shared across sessions
- `psfn-framework-qs83.65` - Memory compatibility wrapper can skip `listMemories` polyfill
- `psfn-framework-qs83.66` - Skill usage first/last timestamps are wrong for out-of-order events
- `psfn-framework-qs83.70` - Malformed emotion telemetry can crash before explicit validation
- `psfn-framework-qs83.73` - Preference category regex alternatives have incomplete word boundaries
- `psfn-framework-qs83.74` - Explicit preference extraction skips any message containing a question mark
- `psfn-framework-qs83.75` - Contact update maps only one not-found message to 404
- `psfn-framework-qs83.76` - Migrated SQLite memories lack retention-class CHECK constraint
- `psfn-framework-qs83.77` - Completion handoff dedupe keys are retained unbounded in memory
- `psfn-framework-qs83.79` - Outfit preference retrieval misses natural wearing queries
- `psfn-framework-qs83.80` - Text-only memory patches do not recompute inferred tags/retention
- `psfn-framework-qs83.81` - Any `preference:*` tag still auto-durables preference memories
- `psfn-framework-qs83.84` - Reflection PATCH accepts primitive JSON and can bump policy version
- `psfn-framework-qs83.85` - Existing Postgres active_concerns tables miss fresh-install CHECK constraints
- `psfn-framework-qs83.86` - Admin bulk memory type plus retention updates can compute tags from old type
- `psfn-framework-qs83.87` - Repeated terminal concern decisions can create duplicate terminal rows
- `psfn-framework-qs83.92` - Concern grooming cap metric can overstate successful trimming
- `psfn-framework-qs83.94` - Standard retention demotion leaves core durable tags
- `psfn-framework-qs83.95` - SQLite bulk type plus retention update computes tags from old row type
- `psfn-framework-qs83.97` - Concern transition accepts `status: null` as active
- `psfn-framework-qs83.100` - Postgres bulk type plus retention update computes tags from old memory
- `psfn-framework-qs83.113` - CogSec smoke can pass with keyword search disabled
- `psfn-framework-qs83.119` - Malformed scopes object is silently treated as empty
- `psfn-framework-qs83.135` - Invalid scope.kind is not reported
- `psfn-framework-qs83.149` - Graph proposal polling can overwrite mutation refresh with stale data
- `psfn-framework-qs83.153` - Participant trend hydration marks room loaded before load succeeds
- `psfn-framework-qs83.155` - Single wiki entry truncation can ignore header separator budget
- `psfn-framework-qs83.157` - wiki_pass subsystem health lane events are dropped
- `psfn-framework-qs83.158` - Stale-memory review scans newest active memories only
- `psfn-framework-qs83.161` - Async wiki projection repair can delete documents written during startup
- `psfn-framework-qs83.165` - Wiki pass gate can open on non-eligible private world-typed memories

### Scheduler, Fatigue, Wakeup, Outreach, And Free-Time

Look for bugs where background lanes use the wrong window, lose restart state, mis-charge activity, or make LLM calls before deterministic eligibility gates.

Common shapes:

- anti-loop scans are too short after restart
- caps are applied before eligibility filtering
- charge/fatigue reports read paginated subsets
- stale carry-over modifiers survive context changes
- scheduler timestamps do not reflect per-task execution
- telemetry callbacks can break scheduling

Retired stale findings:

- `psfn-framework-qs83.13` - Sleep consolidation bounded query can starve newer episodes
- `psfn-framework-qs83.14` - Dream meaning pass can clobber concurrent meaning writes
- `psfn-framework-qs83.19` - Scheduler lastRunAt uses tick timestamp for all tasks
- `psfn-framework-qs83.51` - Fatigue tuning bounds can permit hard cap below soft target
- `psfn-framework-qs83.52` - Fatigue tuning report is based on paginated fatigue events
- `psfn-framework-qs83.54` - Fatigue-suppressed vision turns can record null userSessionEntryId
- `psfn-framework-qs83.56` - Fatigue policy always sees recentMessageCount as one
- `psfn-framework-qs83.62` - Ambient-note anti-loop can miss persisted notes after restart
- `psfn-framework-qs83.102` - Schedule tool guidance omits required follow-up/reminder fields
- `psfn-framework-qs83.128` - conversationScope is private to heartbeat execution
- `psfn-framework-qs83.130` - Expired carry-over modifiers can accumulate for unobserved DM scopes
- `psfn-framework-qs83.131` - Sleeptime telemetry callback can break scheduling
- `psfn-framework-qs83.142` - Non-qualifying transitions do not clear stale carry-over modifiers
- `psfn-framework-qs83.150` - Nudge evaluator drops valid first JSON object when trailing brace text exists
- `psfn-framework-qs83.151` - Partial weightedThoughtOutreach config overrides fail validation
- `psfn-framework-qs83.156` - Outreach caps candidate list before deliverability checks
- `psfn-framework-qs83.159` - Weighted thought store returns shallow clones with shared nested state
- `psfn-framework-qs83.162` - Free-time return notes summarize stale assistant entries
- `psfn-framework-qs83.163` - Temporal wake anti-loop only scans last 64 persisted entries after restart
- `psfn-framework-qs83.164` - Sleeptime wiki prompt includes every existing wiki entry

### Privacy, Security, Path, Secret, And Audit

Look for bugs where sensitive values are exposed, path containment is separator-fragile, attribution is forgeable, or review/audit state is bypassed.

Common shapes:

- reports or docs expose DSNs, credentials, or deployment details
- path checks miss package-root escape cases
- privacy errors advertise retired enum values
- elevated reveal paths create grants without audit
- source-channel identity is confused with routed logical IDs
- text inserted into quarantine or forensic messages is not escaped

Retired stale findings:

- `psfn-framework-qs83.9` - AI audit document remains in tracked docs
- `psfn-framework-qs83.12` - JSON report exposes PostgreSQL URL
- `psfn-framework-qs83.22` - SPIFFE URI validator accepts authority ports
- `psfn-framework-qs83.40` - Generic shard memory mutations lose shard source metadata except writes
- `psfn-framework-qs83.50` - Web circuit breaker key collapses query strings and path case
- `psfn-framework-qs83.55` - Encrypted backup payloadFile can escape the package directory
- `psfn-framework-qs83.72` - Archive entry names are injected verbatim into quarantine reasons
- `psfn-framework-qs83.93` - HTTP JSON response compression uses synchronous zlib in request path
- `psfn-framework-qs83.105` - Forensic archive root check is separator-fragile
- `psfn-framework-qs83.120` - Prompt macro audit misses unknown macros in conditionals
- `psfn-framework-qs83.138` - Attribution-forgery guard misses prefix line ending at colon
- `psfn-framework-qs83.139` - Startup hydration quarantine check uses channelId instead of sessionId
- `psfn-framework-qs83.146` - Agent backend privacy error advertises retired broadcast value
- `psfn-framework-qs83.147` - Elevated reveal creates per-memory grant without reveal audit
- `psfn-framework-qs83.148` - HTTP request privacy error advertises retired broadcast value

### Prompt, Macro, Runtime Context, And Provider Messages

Look for bugs where context identity, prompt cache keys, macro expansion, provider role labeling, or volatile/session-stable boundaries drift.

Common shapes:

- prompt macros hidden in conditional branches are skipped by static checks
- session-stable data is rendered as turn-volatile
- raw channel IDs are exposed where logical room IDs are expected
- provider wire views mislabel tool results as user messages
- fallback-summary detection matches arbitrary failure text
- clone/sanitization helpers miss cyclic arrays or prototype keys

Retired stale findings:

- `psfn-framework-qs83.15` - Retrieval provenance ignores evolution-chain prompt expansion
- `psfn-framework-qs83.31` - Provider response cleanup rejects normal markdown Response headings
- `psfn-framework-qs83.58` - System-language layer lookup can bind the wrong layer
- `psfn-framework-qs83.108` - Prompt monitor safe clone does not track cyclic arrays
- `psfn-framework-qs83.111` - Fallback summaries match arbitrary failed text
- `psfn-framework-qs83.112` - History summary can throw on malformed tool metadata
- `psfn-framework-qs83.123` - runtime_room_id uses raw message channel id
- `psfn-framework-qs83.124` - Prompt-cache telemetry undercounts contradiction retry usage
- `psfn-framework-qs83.126` - Prompt section resolver can inherit Object prototype keys
- `psfn-framework-qs83.127` - Provider wire view labels tool results as user messages
- `psfn-framework-qs83.129` - Namespace accepts keys with trailing parentheses that render unresolved
- `psfn-framework-qs83.133` - Static volatility validation misses conditional macros
- `psfn-framework-qs83.134` - Group reflection still resolves canonical-contact prompt context
- `psfn-framework-qs83.145` - Session-stable prompt blocks are emitted as turn volatile
- `psfn-framework-qs83.152` - Persona preamble normalization flattens operator newlines

### Kubernetes, Helm, Redis, Network, And Deployment

Look for bugs where chart defaults, selectors, mounted files, runtime-mode detection, or secret handling diverge from the live deployment contract.

Common shapes:

- production overlays inherit fields that do not apply to their resource kind
- deployment verifiers use ambiguous selectors
- chart containers skip security context
- secrets are configured but not mounted or passed to the workload
- default passwords survive into base manifests
- runtime detection checks a different mode source than layout resolution

Retired stale findings:

- `psfn-framework-qs83.24` - NODE_ENV=prod production detection drifts from runtime layout resolution
- `psfn-framework-qs83.30` - LiteLLM config path override can point at an unmounted file
- `psfn-framework-qs83.33` - Postgres image helper renders invalid tag-only overrides
- `psfn-framework-qs83.35` - External Redis TLS CA secret is configured but not mounted or passed to agent
- `psfn-framework-qs83.36` - Redis container skips chart container securityContext
- `psfn-framework-qs83.37` - Prefetch network-policy verification uses kind-ambiguous document lookup
- `psfn-framework-qs83.38` - Agent network-policy verification selects psfn-agent by name only
- `psfn-framework-qs83.39` - Postgres database URL does not escape credentials
- `psfn-framework-qs83.99` - Base Kubernetes Postgres secret uses public `changeme` password
- `psfn-framework-qs83.101` - Standalone `postgres-data` PVC is unused
- `psfn-framework-qs83.104` - Production ExternalName overlay can inherit invalid headless service fields

### Garden/Admin/UI Error Mapping And Stale Fetch

Look for bugs where optional fetches break whole panels, stale async responses overwrite current view state, or route errors return misleading statuses.

Common shapes:

- optional data providers fail an entire page
- invalid IDs or validation errors become HTTP 500
- UI falls back to stale snapshots
- pre-invalidation fetches remain reusable
- admin bulk updates compute derived fields from old rows
- "not found" and "bad request" semantics drift under concurrent deletes

Retired stale findings:

- `psfn-framework-qs83.16` - Optional model usage fetch can fail whole Charge/Budget page
- `psfn-framework-qs83.23` - Garden network listen port lacks 65535 upper bound
- `psfn-framework-qs83.42` - Trim-equivalent channel override keys silently overwrite
- `psfn-framework-qs83.47` - Model discovery invalidation leaves pre-invalidation fetches reusable
- `psfn-framework-qs83.64` - Settings UI falls back to lower analysis subquery default
- `psfn-framework-qs83.90` - Concurrent deleted image update returns bad request instead of not found
- `psfn-framework-qs83.91` - Older session message pages load all entries before the cursor
- `psfn-framework-qs83.107` - Malformed-argument retry guard lowercases required field names
- `psfn-framework-qs83.110` - Invalid CogSec enums still surface as route 500s
- `psfn-framework-qs83.132` - Tools tab falls back to snapshot for plan-backed zero-tool turns
- `psfn-framework-qs83.137` - Extended-tool guide ignores custom capability tokens

### Tooling, Provider, Conformance, And Health Surfaces

Look for bugs where synthetic health checks miss real missing actions, provider resolution reports the wrong cause, or conformance surfaces pass without exercising the intended path.

Common shapes:

- health checks are synthetic rather than routed through real RPC
- missing providers are reported as policy disables
- invalid conformance metadata is coerced away
- tool results with details but no text render as empty
- retry/dedupe keys include changing timestamps
- probe warnings are suppressed

Retired stale findings:

- `psfn-framework-qs83.20` - PQC probe suppresses process warnings
- `psfn-framework-qs83.34` - Synthetic vault tool health cannot detect missing vault RPC actions
- `psfn-framework-qs83.41` - self_status can fail when tool-health provider throws
- `psfn-framework-qs83.82` - Missing LLM provider is reported as disabled policy
- `psfn-framework-qs83.83` - Completion handoff dedupe key includes changing completion timestamp
- `psfn-framework-qs83.103` - Image quota preflight blocks `provider: auto` before local provider resolution
- `psfn-framework-qs83.109` - External artifact invalidation failure is mislabeled
- `psfn-framework-qs83.122` - Malformed conformance reasonCodes are coerced to empty
- `psfn-framework-qs83.136` - Persona-conformance failures are not reflected in service ok result
- `psfn-framework-qs83.144` - Tool call details-only successes display no result

### Validation, Normalization, Parser, And Default Semantics

Look for bugs where parser helpers accept impossible states, normalize too aggressively, or treat blank/null/inverted values as meaningful defaults.

Common shapes:

- negation and question marks are stripped out of user intent
- inverted ranges are accepted
- blank strings cannot clear blocks
- malformed numeric maps pass validation
- out-of-range persisted timestamps crash prompt variables
- empty/null values become active/default states

Retired stale findings:

- `psfn-framework-qs83.1` - Negation stripped from episodic queries
- `psfn-framework-qs83.46` - Reversed explicit source span bounds are accepted
- `psfn-framework-qs83.115` - CogSec preview accepts inverted message ranges
- `psfn-framework-qs83.121` - Out-of-range persisted timestamp can crash datetime variables
- `psfn-framework-qs83.125` - Charge policy validator accepts malformed numeric maps
- `psfn-framework-qs83.140` - Reorient cannot clear blocks with empty strings
- `psfn-framework-qs83.141` - Replace cannot clear a block with an empty string

### Persistence, Migration, Upsert, And Data Integrity

Look for bugs where one-time migration, upsert, or review-update semantics are not idempotent or conflict on the wrong key.

Common shapes:

- conflict keys do not match logical uniqueness
- conflict upserts return local timestamps rather than stored timestamps
- sibling workers continue after the first migration failure
- snapshot/config verification ignores unexpected owners
- duplicate review decisions apply multiple times
- same-status transitions overwrite resolution metadata

Retired stale findings:

- `psfn-framework-qs83.3` - --postgres-source-url can be ignored without --postgres-restore-url
- `psfn-framework-qs83.17` - Observer sidecar upserts return local createdAtMs on conflict
- `psfn-framework-qs83.27` - PostgreSQL embedding migration does not stop sibling workers after first failure
- `psfn-framework-qs83.44` - System config snapshot verification does not reject unexpected owner files
- `psfn-framework-qs83.88` - Same-status terminal transitions overwrite resolution metadata
- `psfn-framework-qs83.98` - Duplicate review decisions for one candidate are applied multiple times

### Async, Race, Restart, And Stale State

Look for bugs where process lifecycle, restart, hydration, refresh, or stale state handling can regress state or report success incorrectly.

Common shapes:

- process exits report success after uncaught exceptions
- timers survive disconnects or no-backlog clears
- drafts and selected details stay stale after refresh
- persisted zero values hydrate as one
- regeneration overwrites previous failure status
- startup hydration keys the wrong identity

Retired stale findings:

- `psfn-framework-qs83.49` - Uncaught-exception graceful shutdown can still exit with code 0
- `psfn-framework-qs83.59` - Uptime timer can keep running after external disconnect
- `psfn-framework-qs83.78` - Image tag/moment drafts stay stale across refreshes
- `psfn-framework-qs83.96` - Stale-resolution statuses array coerces null entries to active
- `psfn-framework-qs83.117` - Regeneration can overwrite prior failure status as applied
- `psfn-framework-qs83.154` - Persisted zero context multipliers hydrate as one

### Boundedness, Pagination, Caps, And Unbounded Work

Look for bugs where a system claims to cap work but applies the cap after an unbounded operation, or where a bounded query starves important rows.

Common shapes:

- caps are applied after scan/sort instead of before
- eviction removes insertion-oldest instead of actual least-recent item
- small budgets produce empty summaries
- payload validation can clear existing links or state

Retired stale findings:

- `psfn-framework-qs83.69` - Rate-limit capacity eviction removes insertion-oldest key, not least-recently-logged key
- `psfn-framework-qs83.89` - Invalid image conversation payload can clear existing link
- `psfn-framework-qs83.106` - Recent summary truncation can return empty under small budgets
- `psfn-framework-qs83.160` - Shared-background union cap is applied after unbounded scan and sort

### Other Review Patterns

These did not fit neatly into one bucket from title text alone. Treat them as prompts for future manual audit passes.

Retired stale findings:

- `psfn-framework-qs83.8` - Conflict review heuristic checks one-sided keyword presence
- `psfn-framework-qs83.10` - Outbound handler depends on agentLoop.followUp
- `psfn-framework-qs83.18` - Gateway WSS endpoint rejects explicit default port 443
- `psfn-framework-qs83.21` - Shared guard verifier misses const arrow isRecord definitions
- `psfn-framework-qs83.67` - Voice turns can complete without spoken text for attachment-only responses
- `psfn-framework-qs83.68` - Raw charge-policy JSON edits can be lost on toggle
- `psfn-framework-qs83.71` - Failed turns can retain intentional no-reply decisions
- `psfn-framework-qs83.114` - Auto-compaction classifies routed logical id instead of source channel
- `psfn-framework-qs83.116` - CogSec tombstone retries are not idempotent
- `psfn-framework-qs83.118` - CogSec-tagged persona mutations can bypass review
- `psfn-framework-qs83.143` - Standalone from now on triggers persona mutation failure

## Closing Policy Used For This Cleanup

Close reason for the retired child bugs should say:

> Stale/obsolete after major post-Cubic codebase update; retired per operator instruction on 2026-07-08. This is not a fix verification. Bug pattern preserved in working_docs/2026-07-08-cubic-p2-stale-bug-taxonomy.md for future audits.

Close reason for the parent epic should say:

> Stale/obsolete after major post-Cubic codebase update; all 165 P2 child bug beads retired as stale per operator instruction on 2026-07-08. Useful bug classes preserved in working_docs/2026-07-08-cubic-p2-stale-bug-taxonomy.md. This does not assert individual fixes.

