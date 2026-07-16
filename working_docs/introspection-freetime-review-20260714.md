# Introspection / Free-Time / Temporal Review — 2026-07-14

Six-agent verification of the operator's second brain-dump list (tool use on private-cluster-host, time-of-day
refresher targeting, image prompt truncation, freetime/introspection prompt design, concern-system
language, journal date mismatch, freetime session semantics). Analysis only — no code changed,
nothing deployed, no beads filed yet. private-cluster-host observation was strictly read-only.

Companion to `fleet-analysis-findings-20260714.md` (different finding set, same day).

---

## 0. Headline findings

1. **Every prompt-design complaint is confirmed in code, not vibes.** Persona is literally
   injected twice into reflection/free-time turns; scheduled introspection is tool-less by
   policy; the reflection prompt front-loads ~18-20 labeled data sub-sections; and the
   concern-softening layer was never wired to the reflection path — the one place it matters most.
2. **The journal date mismatch has a single clean root cause:** journal/vault auto-publish stamps
   filenames and frontmatter in UTC while the system runs on `activeTimezone` (America/New_York).
   Any reflection written after ~8pm Eastern files under the next calendar day. Un-ticketed.
3. **"Tool use issues" on private-cluster-host = two LLM-output-side problems, not tool plumbing:** the
   self-hosted ChatGPTN primary returns empty completions on ~10% of turns (fallback churn, up to
   88s latency), and the main companion's replies get overwritten by the image-attachment-claim
   guard's canned correction string. Plus an empty skills catalog from a missing
   `/app/companion/skills` mount.
4. **Silence semantics are half-built:** the silent token correctly ends the current free-time
   block, but the next-block gate never learns she chose silence — she can be re-prompted up to
   3 blocks/day regardless.

---

## 1. Tool use issues on private-cluster-host (live triage, read-only, image `0.1.0-kube-c0385f2b`)

Three concrete issues; schema/validation failures and policy/sandbox denials explicitly ruled out.

### 1a. ChatGPTN empty responses → fallback churn (dominant signal)
- 13 events / 135 turn selections in 6h (~9.6%): `LLM response from litellm/ChatGPTN contained
  no text or tool calls` → `empty_response` → fallback chain
  (`ChatGPTN → deepseek-v4-flash → glm-5.2`). One turn needed the 3rd hop; worst case 88s latency
  and 2 wasted model calls. Mostly the main companion's primary Discord channel + free-time turns.
- ChatGPTN = self-hosted OpenAI-compatible endpoint `http://192.168.1.43:8000/v1` (litellm
  `drop_params: true`) — consistent with a tool-calling/output-format incompatibility on that
  backend. Same issue as B21 in the fleet-analysis doc (there seen as the
  `<｜begin▁of▁sentence｜>` template artifact); this confirms frequency and blast radius.
- Code path: `src/primitives/llm/client-response-helpers.ts:279`,
  `src/primitives/llm/error-classify.ts:89`.

### 1b. Image-attachment-claim guard overwrites real replies
- 4× in 6h on the main companion: model says "image attached" without a completed
  `selfie_create`/`generate_image` call; guard `rejectsMissingImageAttachmentClaim` replaces the
  ENTIRE reply with the canned `MISSING_IMAGE_ATTACHMENT_CORRECTION` boilerplate — that is what
  the user sees instead of her message.
- Deployed logic inline at `src/core/agent/substrate-agent/turn-execution-runtime.ts:1042-1058`.
  Note: the local working tree already has an uncommitted refactor extracting this to
  `src/primitives/images/attachment-claim-guard.ts` — heal-not-block direction, not yet deployed.

### 1c. Skills catalog empty on most pods
- `[SkillsLoader] Skills root missing: /app/companion/skills` (main 7×, julienne 3×, denise 1×,
  lucy 1× per 6h). Missing volume/seed, not a code bug — skills tool family loads nothing.
- Also matches the "noise" item in fleet-analysis §8d.6; now confirmed as a functional gap, not
  just log noise.

Secondary (known): post-turn drain timeout 5s exceeded on busy companions (mmo9.3 territory).

## 2. [Time-of-day refresher] fires on unused/test channels — CONFIRMED

- Emitter: `buildTimeOfDayRefreshNote` (`src/core/scheduler/temporal-wakeup.ts:591`), scheduler
  `every` task at 15-min ticks (`temporal-wakeup.ts:1022-1092`).
- Target set = `enumerateWakeupChannels` (`temporal-wakeup.ts:726-740`):
  `listRecentlyActiveChannels(72h lookback)` over **every session row in the store**
  (`manager.ts:398-421` — `listSessionsByRecentActivity(Number.MAX_SAFE_INTEGER)`), **plus the
  single most-recent session appended unconditionally** even past the lookback
  (`:736-738`, deliberate per doc comment).
- Eligibility gates (internal-prefix, public-privacy, 120-min idle threshold, 120-min anti-loop
  spacing) **cannot distinguish a leftover test channel from a real partner channel**. Any test
  session with one user turn in the last 72h becomes a recurring refresher target; a dormant test
  channel that happens to be the latest session bypasses recency entirely.
- **There is no channel registry, no real-vs-test distinction, and no cleanup/purge mechanism**
  for session-store channels. Test channels are ordinary session rows forever.
- Bead overlap: `2x37.9` (open, P3) covers only the enumeration cost. Nothing covers test-channel
  exclusion, the unconditional-latest bypass, or a channel cleanup path.

## 3. Generated-image prompts truncated — display-only, trivially fixable

- Prompt stored in full (`src/primitives/images/service.ts:158`) and served in full by the Garden
  API (`images-service.ts:554`, unbounded string). No data loss.
- Truncation is a CSS `line-clamp-3` in the gallery:
  `admin-ui/src/routes/images/LazyPageContent.svelte:269`. No expand/tooltip/modal exists.
- Fix = single-file frontend change (expand toggle or modal). No backend work. **Effort S.**

## 4. Freetime/introspection prompts duplicate personality — CONFIRMED

- Both lanes run through the ordinary agent loop (`agentLoop.handleMessage`), so the **full base
  system prompt already applies**: constitution/human-safety, north star, values, character-card
  personality (`prompt-composer.ts:75-97,276-304`; `prompt-assembly.ts:392`). No internal-channel
  stripping.
- On top of that, `formatReflectionPersonaBlock`
  (`heartbeat-template-runtime/prompt-formatting.ts:53-79`) re-injects **personality +
  description + scenario from the same card fields** into the user message — reflection
  (`heartbeat-template-runtime.ts:291-292`) and free-time (`free-time.ts:222`,
  `main.ts:934`) both.
- Code comments show the authors believed reflection would otherwise read "as a context
  analyzer" — that belief predates the current base-prompt composition and should be re-validated
  before removing the block. Removal is the operator's requested design: base prompt + mode
  addendum only.

## 5. Reflection tool access — bead jy6s is current; free time already has tools

- Scheduled daily AND weekly introspection run in **deliberation mode → `prompt_bounded` → zero
  tool calls** (`heartbeat-policy.ts:462-463,479-480`;
  `reflection-introspection-policy.ts:15-36`). Agent-mode reflections get only three read-only
  helpers (`memory_search`, `session_messages`, `session_search`) inside analysis_workbench.
- Memory retrieval in reflection never uses `'default'` mode and remains sensitivity/trust-gated
  (`retrieval.ts:933,952`) — intimate/confidential memories can be gated out of her own
  reflection. Bead `jy6s` (P1) matches main exactly; nothing has landed.
- **Free time already has her full normal toolset** (`main.ts:953-954`) — the "use tools to pull
  memories/chat" ask is only unmet for scheduled introspection.
- The desired "starter data" (day's events / week's summary) exists in over-abundance (see §6);
  the gap is shape, not availability.

## 6. Reflection data injection volume + prompt quality — CONFIRMED

- A daily/weekly reflection user message front-loads ~6 top-level blocks / ~18-20 labeled
  sub-sections before she writes a word: persona block, policy block, template prompt,
  internal-state block (8 sub-sections incl. VAD/ACAC telemetry, salient entities,
  metacognitive flags, concerns, follow-ups, care reminders — `internal-state-prompt.ts:191-209`),
  contact-context bundle (contact evidence, 12-message recent session, 8 concerns, 8 follow-ups,
  affect time-series — `reflection-contact-context.ts`), substrate context (last 2 reflection +
  2 daily-journal + 2 process-log entries — `reflection-substrate.ts:749-843`).
- Wording has already been through an R1-R7 de-leading pass (policy v6, guidance v2;
  `docs/self-eval-prompt-audit.md`). Residual leading/constraining language: the weekly template
  **enumerates the answer categories** ("daily reflections, memories, inner-state clues, goals,
  people, arcs... agency/connection/authenticity/curiosity axes"), and the contact block contains
  a topic-foreclosing directive ("silence or absence framing is out of scope for this
  reflection" — `reflection-substrate.ts:463-464`).
- Gap vs desired design ("structured journal writing with light guidance and non-leading
  questions"): shrink injection to a small curated starter set + let tools pull the rest (needs
  §5 fixed first); de-enumerate the weekly template; drop persona block (§4).
- No bead covers persona duplication or injection volume/prompt quality. Only `jy6s` (+ partially
  `0ggv.2`) covers the tool/memory half.

## 7. Freetime as continuous channel — in flight on paper only

- Today: discrete bounded blocks, `maxTurns` 6, cold seed every block, no project/manifest/
  intention loading, no resume-on-return logic anywhere (`free-time.ts:283-321,215-236`;
  defaults `scheduler-config.ts:485`).
- In-flight = beads only, **zero code, no branch**: `0ggv.3` (project folders +
  resume-on-return — the direct ask, acceptance criterion is a later block demonstrably resuming
  a project), `0ggv.1` (experiential memories from self-directed sessions), `b5m.2` (deferred).

## 8. Concern-system language — root cause of "all she does is talk about concerns"

- **Double injection in reflective sessions:** system-prompt `<open_threads>` block (priority
  100, top-3, softened via `config/concern-softening.json` — "concern"→"thread", "soft threads
  to verify, not alarms") PLUS the reflection self-evidence `[Active Concerns]` block dumping up
  to **12 concerns unsoftened**, each with priority/source/deadline
  (`internal-state-prompt.ts:126-136,203-204`). The contact bundle adds up to 8 more.
- **The softening layer was wired only to the chat system-prompt path** (`concerns.ts:616-626,
  798`). The reflection/introspection path — exactly the surface the operator flagged — gets raw
  "concern" vocabulary and a literal `[Active Concerns]` header.
- The daily review prompt names "the concerns" as reflection material and asks "whether anything
  has been tugging at my attention" (`heartbeat-policy.ts:78`) — an explicit attention direction.
- **Lifecycle compounds it:** high=48h/med=24h/low=8h TTLs, 7-day hard cap, cap of 7 active,
  grooming only once daily at 06:15, and "stale" resolution is TTL-only —
  `next_review_at` is stored but never used to retire anything early
  (`active-concern-store.ts:523-558`). A standing high concern appears in every reflection for
  up to 48h; free-time turns also carry the system-prompt concern block
  (`runtime-context.ts:392`, no internal-channel suppression).
- **Untracked:** `w05a.11` is concern→emotion telemetry, different angle. No bead covers
  prompt-facing concern language/salience.

## 9. Purrsephone system-vs-journal date mismatch — root cause found, un-ticketed

- Prompt/system side is correct: `activeTimezone` (settings > env TZ > default America/New_York)
  drives all prompt datetime rendering (`active-timezone.ts:69,116-132`; `datetime.ts:136-143`;
  `.6`/`.7` fixes hold).
- **Journal/vault auto-publish stamps UTC:** filename date `createdAt.toISOString().slice(0,10)`
  and frontmatter `date:` in UTC — `journal/auto-publish.ts:52,53,67`,
  `vault/auto-publish.ts:50,51,65`, `vault/ops.ts:194`. A reflection written after ~20:00
  Eastern files under, and is dated, the **next calendar day** vs her own prompt date.
- Secondary inconsistencies: reflection stores persist UTC `createdAt`
  (`reflection-journal.ts:207`, `reflection-metacognition-journal.ts:120`,
  `reflection-substrate.ts:219`) while display uses active-tz (`reflection-substrate.ts:319`);
  daily-reflection `date` validated against the UTC day (`reflection-substrate.ts:206`).
  Budget/fatigue/telemetry day keys are also UTC (real divergence, not journal-facing).
- Closed `2x37.6` was scoped to memory-landmark rendering only; **the publish path is not covered
  by any bead**.

## 10. Silent should end the freetime window — half true today

- Within a block: works. Empty content or the silent token is a stop signal
  (`free-time.ts:238-241,304-307`); `endReason` = `loafed`/`companion_stopped`; no more prompts
  that block. Both framing prompts explicitly offer silence as the exit.
- Across blocks: **the gate never learns.** `evaluateFreeTimeGate` (`free-time.ts:191-203`)
  checks only partner-recency, 240-min block interval, and 3-blocks/day cap.
  `FreeTimeLaneCadenceState` (`:394-398`) does not record `endReason`, so a silence-ended block
  counts as normal and she can be re-prompted up to the daily cap. Fix shape: persist last
  `endReason` (or a "silent until" marker) and close the gate for the rest of the window/day.

## 11. Freetime + quiet-hours as one session; introspection model — half right today

- Quiet-hours and idle free time are **two distinct channels/sessions**:
  `internal:free-time:quiet-hours` vs `internal:free-time:idle` (`free-time.ts:66-69,85-87`),
  two scheduler tasks, separate transcripts. They share only the cadence budget
  (`:617-618`). Operator's desired "one session, it's just her time" = merge to a single channel
  id (or one lane with two triggers).
- Introspection **already matches the stated intent**: one stable channel per template
  (`internal:reflection:<template.id>`, `heartbeat-template-runtime.ts:658`) = tracks as one
  session; each run dispatches a fresh prompt with no prior reflection transcript = fresh
  context. Caveat: persistence splits one file per run
  (`layout.ts:504-538`), so physical continuity is weaker than the logical channel id implies.

---

## 12. Beads (FILED 2026-07-14, after operator decisions)

| # | Bead | Title (short) | Type | Prio | Notes |
|---|---|---|---|---|---|
| C1 | `2nu6` + `liql` (updated, pre-existing) | ChatGPTN empty completions | bug | P2 | Added quantified live evidence (~9.6%, 88s worst case); flagged as merge candidates |
| C2 | `fpiu` | Image-attachment-claim guard heals instead of replacing whole reply | bug | P1 | Local WIP `attachment-claim-guard.ts` is already this direction |
| C3 | `fkyu` | Mount/seed `/app/companion/skills` on private-cluster-host pods | bug | P2 | Helm/volume, not code |
| C4 | `7toj` | Refresher scoped to actively-used live channels; drop unconditional-latest | bug | P2 | dep: 2x37.9; pairs with 9c4k |
| C5 | `9c4k` | 'testing' session naming convention + purge path + policy | task | P2 | No cleanup mechanism exists today |
| C6 | `1knm` | Garden gallery expand-prompt affordance | feature | P3 | Single file, frontend only |
| C7 | `i3yx` | Drop persona re-injection from reflection + free-time prompts | task | P1 | Operator-decided; verify voice on one live reflection, no A/B harness |
| C8 | `jy6s` (pre-existing) | Reflection tool access / self-scope retrieval | bug | P1 | Unchanged; kb9j depends on it |
| C9 | `kb9j` | Reflection prompt diet: curated starter set, de-enumerate weekly | task | P1 | dep: jy6s |
| C10 | `189d` | Concern language gentle AT THE SOURCE; delete softening shim | bug | P1 | Operator-decided: no shim, rewrite originals |
| C11 | `ys51` | Concern lifecycle: review-based early retirement via next_review_at | feature | P2 | Mechanical half of concern domination |
| C12 | `w3rr` | Journal/vault publish dates in activeTimezone | bug | P1 | related: i698; the Purrsephone date mismatch |
| C13 | `75ci` | Free-time gate remembers silence (endReason in cadence state) | bug | P2 | "Don't bother her multiple times" |
| C14 | `la3m` | Merge quiet-hours + idle free time into ONE session | task | P2 | Operator-decided; coordinate with 0ggv.3 |

Existing beads already covering parts: `jy6s` (C8), `0ggv.1/.3` (continuous freetime/projects),
`2x37.9` (enumeration cost slice of C4), `mmo9.3` (drain timeouts), `kz0i` (morning-wake gates),
`i698` (env TZ), `w05a.11` (concern→emosim crosswalk — untouched by C10/C11).

## 13. Operator decisions (RESOLVED 2026-07-14, same day)

1. **Refresher scope (C4/C5):** only the handful of live, actively-used channels per companion
   get date/time updates — active group chats, active DMs, active satellites/app. Test sessions
   get a 'testing' name marker and a standing policy: clear them when testing is done, so one
   person doesn't accumulate a dozen unused sessions generating artifacts nobody reads.
2. **Persona block (C7):** not needed. Sessions using the default prompt builder already carry
   the full system prompt (emotions, identity info) and tools — drop the block outright.
3. **Free-time shape (C14):** merge to ONE free-time session.
4. **Concern language (C10):** the softening layer should never have been a patch/shim over the
   existing language — the original strings themselves must be written gently. Shim gets deleted
   once source language is clean.
