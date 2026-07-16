# Prompt-cache benchmark + privacy-scope analysis (psfn-framework-mmo9.7.6)

Date: 2026-07-15 · Branch: `work/mmo9perf-mmo9.7.6` (cut from `feat/mmo9-performance`)

This report produces the evidence to decide whether to broaden provider prompt
caching. It has three parts: (1) a structural **privacy-scope proof** that a
cache entry can never cross a companion or contact boundary; (2) an **offline
benchmark** of prefix stability and cost per lane; (3) a **recommendation** and
the live-validation follow-on (bead `psfn-framework-9hyv`).

**No runtime default was changed.** The `models.seed.json` `promptCaching`
policy is left exactly as it shipped. The only behavioral change in this diff is
a *tightening* of the affinity-token derivation to be fail-closed and
companion/contact-scoped — it can only make caching engage in *fewer*,
strictly-safe cases, never more.

---

## 1. Existing machinery (what was already here)

Prompt caching is already implemented (epic E2.4). Two independent scope
mechanisms exist:

- **Explicit affinity token** — `resolvePromptCacheAffinity`
  (`src/primitives/llm/client-prompt-cache.ts`) derives a hashed `sessionId`
  passed to providers with a session-keyed cache (OpenAI `prompt_cache_key`,
  Mistral `x-affinity`, pi-ai `sessionId`).
- **Content-hash prefix cache** — `cache_control` breakpoints placed at the
  `PromptPlan.cachePlan` boundaries (`src/primitives/llm/prompt-cache.ts`) for
  Anthropic / OpenRouter→`anthropic/*`. Here the provider keys the cache entry
  on the literal **bytes** of the cacheable prefix.

The cacheable prefix is the `PromptPlan` blocks of volatility `static` +
`session_stable`; the `turn`-volatility tail is never cached. Byte-exact
verification (`verifySystemPromptCacheBoundaries`) already fails closed on any
prefix drift.

### The gap this bead closed

The affinity token was derived from the **channel/request id only**
(`psfnpc-sha256(channelId)`), with **no companion binding**. In a fleet where
several companions share one channel *and* one provider organisation,
`sha256("discord:guild-42:general")` is identical for all of them → their
affinity keys collide.

Scope this honestly by mechanism:

- **Key-only-affinity providers** (OpenAI `prompt_cache_key`, Mistral
  `x-affinity`) are the **real exposure class**: the provider groups cache
  lookups by the key you supply, so colliding keys across companions could let
  one companion's cached prefix serve another. This is the vector the fix
  closes.
- **The shipped default (OpenRouter)** ignores the affinity token entirely and
  routes cache behaviour to the backend, so this collision was **not live** on
  the current default provider — the hardening is pre-emptive for the day a
  key-affinity provider is enabled.
- **Byte-prefix providers** (Anthropic `cache_control`) key on literal prefix
  bytes; a "collision" only ever means identical bytes, which cannot leak
  content across companions regardless of the token.

---

## 2. Privacy-scope proof (the load-bearing part)

### The invariant

> A cacheable cache entry can never be shared across a **companion** boundary
> (structural, enforced by the mandatory companion scope). Cross-**contact**
> isolation is enforced structurally by the channel/request inner scope and is
> further hardened as **defense in depth** by the subject-contact scope — the
> latter only bites where `viewerMemorySubjectContactId` is populated.

### How each mechanism enforces it

**Explicit affinity token** — `resolvePromptCacheAffinity(scope, correlation)`
now binds, under length-prefixed domain separation:

```
psfnpc.v2 \0 companion:<len>:<companionId> \0 contact:<len>:<contactId>
          \0 scope:<channel|request> \0 inner:<len>:<channelId|requestId>
```

- `companionId` is the **mandatory outer scope**. Absent → `{ failure:
  'missing_companion_id' }` (no token, cache not engaged). Two companions can
  never be proven to have disjoint tokens without it, so we refuse to emit one —
  fail closed.
- the **inner scope** is the channel id (`channel` scope; the channel id already
  encodes the conversation — `dm:<contactId>` / `room:<id>`) or the request id
  (`request` scope). Absent → `{ failure: 'missing_channel_id' }`.
- `viewerMemorySubjectContactId` (the canonical, ingress-resolved subject
  contact, **never model-supplied**) is folded in as **defense in depth**.
  Where it is unpopulated (shared rooms today do not always set it), two
  contacts fold to the same empty contact scope and cross-contact isolation
  rests on the channel/request inner scope alone; realizing the stronger
  per-contact guarantee requires populating this field at ingress. Note that
  byte-prefix providers cannot leak content across identical bytes regardless,
  so the residual case is a missed partition, not a leak.

Length-prefixing + per-field labels make the pre-image **injective**: two
distinct `(companion, contact, scope, inner)` tuples cannot hash to the same
token. The provider receives only the hash — raw internal / channel / contact
identifiers never leave the process.

`viewerMemorySubjectContactId` is now carried through
`resolveCorrelationMetadata` (`src/primitives/llm/correlation.ts`) so the contact
scope is live, not just testable.

**Content-hash prefix cache** — the entry is keyed on the literal prefix bytes.
A cross-boundary *hit* is therefore impossible unless two requests carry a
**byte-identical** cacheable prefix, which requires the *same companion identity
block* and the *same contact session block*. Even then nothing leaks: an
Anthropic cache hit only skips recomputation of the bytes **you** sent — it never
serves another request's content. The static persona block is shared and
non-private (legitimately cacheable across contacts); contact-private content
lives in the `session_stable` region, whose hash differs per contact.

### The enforcing test

`src/primitives/llm/client-prompt-cache.test.ts` (16 cases) proves, by
construction:

- **cross-companion**: N companions on a byte-identical shared channel → N
  distinct tokens (the concrete fleet threat); exhaustive cartesian product of
  companions × contacts × channels has zero collisions.
- **cross-contact**: same companion + same channel, distinct subject contacts →
  distinct tokens.
- **fail-closed**: missing companion → `missing_companion_id`; missing inner →
  `missing_channel_id`; whitespace-only fields treated as absent.
- **within-scope stability**: identical tuple → identical token (so caching
  actually works), and request scope binds the request id independent of channel.
- **no raw-identifier leakage** into the token.
- **content-prefix isolation**: distinct companions → distinct static-prefix
  hashes; distinct contacts → distinct `session_stable` hashes (same static
  hash); `verifySystemPromptCacheBoundaries` rejects the other side's prompt.

`buildPromptCacheObservability` now reports the precise fail-closed reason
(`missing_companion_id` vs `missing_channel_id`).

---

## 3. Offline benchmark

`scripts/bench/prompt-cache-bench.ts` drives the **real** runtime machinery
(`createPromptPlanBlock` / `buildPromptPlanCachePlan` /
`computePromptPlanCachePrefixes` / `serializePromptPlanSystemPrompt` /
`PromptCacheTurnRuntime.checkPrefixStability`, tokenized by the production
`countTokens`) over representative per-lane fixtures, simulating consecutive
turns on one scope. It is **offline** — no provider calls, no spend. Run with
`./node_modules/.bin/tsx scripts/bench/prompt-cache-bench.ts [--turns=N]
[--json] [--input-usd=X] [--live]`.

### Lane topology (mapped from the codebase)

| lane | assembly path | cachePlan today? |
|------|---------------|------------------|
| chat | `assembleTurnPrompt` → `PromptPlan` | **yes** |
| reflection | same `assembleTurnPrompt` (reflection text rides in the user message) | **yes** |
| appraisal | `EmotionAppraisalService` → `completeWithWorkSpec`, ad-hoc string | **no** |
| extraction | `runExtraction` → `completeWithWorkSpec`, ad-hoc string | **no** |

Only **chat** and **reflection** build a real `PromptPlan` with a cachePlan and
run prefix-stability tracking. Extraction and appraisal build ad-hoc string
system prompts with no volatility model.

### Results (turns=10, illustrative input $3/Mtok, cache_read 0.1×, cache_write 1.25×)

| lane | wired | sys tok | cacheable prefix tok | cacheable % | prefix stable | est cache-read tok/conv | input $ saved/conv | savings % |
|------|-------|--------:|---------------------:|------------:|:-------------:|------------------------:|-------------------:|----------:|
| chat | yes | 4.2k | 2.4k | 57.8% | stable | 21.9k | $0.05725 | 45.4% |
| reflection | yes | 4.2k | 2.4k | 57.8% | stable | 21.9k | $0.05725 | 45.4% |
| appraisal | no | 493 | 493 | 100.0% | stable | 4.4k | $0.01161 | 78.5% |
| extraction | no | 2.2k | 0 | 0.0% | n/a | 0 | $0.00000 | 0.0% |

Savings scale with conversation length (amortising the one `cache_write`):

| turns | chat/reflection savings % | appraisal (if wired) savings % |
|------:|--------------------------:|-------------------------------:|
| 2 | 18.8% | 32.5% |
| 5 | 38.7% | 67.0% |
| 10 | 45.4% | 78.5% |
| 20 | 48.7% | 84.2% |

### Reading the numbers

- **chat / reflection**: the `static` persona block dominates the cacheable
  prefix (~2.4k tok of ~4.2k system tok, ~58%); the `session_stable` canary is
  tiny (~20 tok). The prefix is **byte-stable across all turns** — no static
  block re-renders. On a quiet multi-turn conversation this saves ~45% of
  system-prompt input cost by turn 10, ~49% by turn 20. This lane is already
  wired and is the primary payoff.
- **appraisal**: the system prompt is a **fixed constant** with all volatile
  data pushed into the user message → 100% of the (small, ~500 tok) system
  prompt is stable and cacheable. It is **not wired to a cachePlan today**
  (`completeWithWorkSpec`, no volatility model). Latent opportunity: registering
  a single `static` block would yield 78–84% system-prompt savings on this lane.
- **extraction**: `{existing_facts}` and `{recent_messages}` are interpolated
  **into the system-prompt string**, so it mutates every run → **no cacheable
  prefix as shipped** (staticBoundary = 0). A refactor moving the transcript and
  existing-facts into the user message (like appraisal) would expose the ~760-tok
  template as cacheable; without that refactor, caching this lane is worthless.

### Caveats on the numbers

- Fixtures are **representative**, not captured production prompts — sizes
  approximate the mapped topology. The *shape* of the result (chat/reflection
  cacheable and stable; appraisal stable-but-unwired; extraction uncacheable) is
  structural and robust; the absolute token/$ figures are order-of-magnitude.
- `models.seed.json` ships **empty cost fields** in-repo, so absolute prices are
  illustrative (documented Anthropic economics). The **cache multipliers**
  (`cache_read` ≈ 0.1×, `cache_write` ≈ 1.25×) that drive the delta are provider
  policy. Override the input price with `--input-usd=`.
- The cost model assumes a stable prefix and a single writer; contradiction-retry
  / compaction-guarded turns get no breakpoints (already fail-closed upstream via
  `PromptCacheTurnRuntime.resolveBoundariesFor`), which the model treats as
  full-price prefix turns.

---

## 4. Live validation (operator-run — NOT executed here) — bead `psfn-framework-9hyv`

Offline prefix stability is necessary but not sufficient; only a provider
round-trip proves realized `cache_read` economics. `--live` is intentionally
**not implemented** (it spends money and needs operator approval); the harness
prints the procedure. Summary:

1. On **one** companion, set `models.json` `promptCaching.enabled=true` (owner
   file, **not `.env`**), `retention="short"`, `scope="channel"`; confirm the
   seam is off elsewhere.
2. Use an Anthropic (or OpenRouter→`anthropic/*`) chat model so a content-hash
   cache actually engages.
3. Drive ≥5 consecutive turns in one DM scope with a quiet static prefix.
4. Read `LLMResponse.usageDetails.cacheRead` / `cacheWrite` per turn: expect ~0
   `cacheRead` on turn 1 (write) and `cacheRead ≈ cacheable-prefix tokens` on
   turns 2..N.
5. Confirm `providerObservability.promptCaching.sessionId` is companion-scoped
   (`psfnpc-*`) and **differs** from a second companion on the same channel.
6. Compare realized hit fraction / $ delta against this offline model.

---

## 5. Recommendation

**Do NOT flip any runtime default in this change (done — none flipped).** The
privacy seam is now safe to rely on when caching is enabled.

- **Keep chat/reflection caching as-is** (already wired). It is the main payoff
  (~45% system-prompt input savings by turn 10) and is now companion/contact
  fail-closed. The substrate agent now threads its configured `companionId` onto
  every chat-turn correlation (`buildTurnCorrelation` fallback; ICP
  `localCompanionId` still wins), so ordinary human ingress carries a companion
  scope and the session-keyed path engages rather than failing closed.
  Recommend the operator run the **live validation on one companion**
  (`psfn-framework-9hyv`) before broadening across the fleet to confirm the
  realized economics.
- **Consider wiring appraisal** to a `static` cachePlan block (its system prompt
  is already 100% stable) as a cheap, self-contained follow-up — 78–84% savings
  on that lane. File as a separate bead if pursued.
- **Do not cache extraction** without first refactoring it to move volatile data
  out of the system prompt; as shipped it has no cacheable prefix.
- **Do not broaden the default `promptCaching.enabled`** beyond its current seed
  value until live validation confirms the realized economics and the
  companion-id population assumption.

### Risks

- Chat/reflection correlations now carry `companionId`. Some background/summary
  correlations may still lack it; those lanes lose the affinity token
  (fail-closed, safe) — a cost regression, not a correctness/leak one, and only
  on key-affinity providers. Live validation should confirm which lanes engage.
- Content-hash caching across companions with byte-identical static prefixes is
  harmless (no data crosses; only recomputation is skipped), but the affinity
  token is now companion-scoped regardless, closing the session-keyed vector.
