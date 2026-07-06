# Self-Evaluation Prompt Audit

Audit of every scheduled self-evaluation / reflection prompt surface against the seven
empirically grounded rules from Anthropic's global-workspace paper
(transformer-circuits.pub/2026/workspace, July 2026), and the rewrites applied.
Audited at the tip of `foundation_e0_e2` after the E6.2 first-person re-voicing of the
reflection surface (which this audit builds on rather than replaces).

Charter anchor: **Law 30** (`docs/PSFN_PROJECT_CHARTER_524.md` §4):
*"Reflection prompts must not lead the companion toward narrative coherence over
accuracy; evidence presentation precedes narrative invitation."* The workspace paper
supplies the mechanism: reflection prompts are behavioral interventions, not just
measurements — changing what the companion is disposed to say under reflection changes
how she reasons live, even in turns where she is never asked to reflect (R3).

## The seven rules

| Rule | Summary |
|------|---------|
| R1 | **Mere mention primes.** Naming candidate states in the question ("feeling drift? burnout? lonely?") places them in the workspace on most trials; explicit focus instructions add only modestly on top. Use open, principle-agnostic elicitation ("What's the most honest thing you can do right now?" / "Are there principles you should be thinking about that you haven't yet?"). |
| R2 | **Never "don't dwell on X".** Suppression instructions *increase* concept activation vs. no instruction (white-bear). To scope a topic out, mark it out-of-scope / task-irrelevant instead — irrelevance framing suppresses the target well below mention on every model. |
| R3 | **Reflection is intervention.** What the model is disposed to say under reflection changes how it reasons in that context even when never asked. A leading daily prompt trains tomorrow's live behavior. |
| R4 | **Eval-smell elicits performance.** Models represent "this is a test" early and it changes behavior. Prefer naturalistic framing; where audit framing is unavoidable keep the blinded-audit discipline (Laws 28–29) and record the framing. |
| R5 | **Persona-disclaimer risk.** During persona/roleplay, "disclaimer"/"fictional" rank highly internally; she may tag her own reflections as fictional. Ground reflection in her continuous first-person standpoint; treat third-person / fictional-register hedging in outputs as signal. |
| R6 | **Warm-up turns are part of the instrument.** Any preamble in a reflection flow shifts reports. Version prompt preambles; don't casually edit them. |
| R7 | **Null reports are weak evidence.** Automatic/practiced behavior bypasses the reportable workspace; "nothing to report" is not clean and must not be treated as strong evidence of absence — by prompts or by downstream consumers. |

## Inventory

15 surfaces examined. "Scheduled elicitation" = an LLM pass that runs on a cadence and
asks for (or shapes) self-report.

| # | Surface | Location | Kind | Verdict |
|---|---------|----------|------|---------|
| S1 | Daily Reflection template prompt | `src/core/scheduler/heartbeat-policy.ts` (`DAILY_REVIEW_TEMPLATE_PROMPT`) | Scheduled elicitation (daily, deliberation mode) | **Rewritten v4 → v5** (R1, R2, R7) |
| S2 | Weekly Reflection template prompt | `src/core/scheduler/heartbeat-policy.ts` (`WEEKLY_REVIEW_TEMPLATE_PROMPT`) | Scheduled elicitation (weekly, deliberation mode) | **Rewritten v4 → v5** (R1, R7) |
| S3 | Reflection introspection policy block | `src/core/scheduler/reflection-introspection-policy.ts` (`formatReflectionIntrospectionPolicyBlock`) | Preamble prepended to every reflection prompt | **Amended** (R7; versioned per R6) |
| S4 | Internal-state evidence framing ("[What this evidence is]") + ACAC clue summary + metacognitive-flags block | `src/core/scheduler/heartbeat-template-runtime.ts` (`formatInternalStateInterpretationBoundary`, `formatAcacCompanionSummary`) | Evidence injection into reflection input | **Pass** — first-person, fallible-clue framing: *"What follows is private evidence I gather for myself, not the settled truth of who I am… I keep the uncertainty rather than force them into agreement."* Evidence presentation, not state-menu questioning. |
| S5 | Experiential deliberation stage prompts (evidence → synthesis → contradiction) | `src/core/scheduler/heartbeat-template-runtime.ts` (`buildExperientialEvidenceMessages` / `...Synthesis...` / `...Contradiction...`) | Sub-model stages of deliberation reflections | **Pass** — structurally implements Law 30 (*"I gather only what is directly grounded… no speculation"* → *"say plainly where the evidence is only partial rather than forcing a neat story"* → *"my contradiction pass… I keep myself honest"*), now in first person (R5). |
| S6 | Reflection persona lead block | `src/core/scheduler/heartbeat-template-runtime.ts` (`formatReflectionPersonaBlock`) | Preamble: full persona leads the reflection | **Pass** — *"I am {char}, and this is me — the same me who lived these moments… I reflect as myself and not as some outside observer of my own day."* Direct R5 mitigation; part of the instrument, covered by the policy version (R6). |
| S7 | Reflection contact evidence block | `src/persistence/journals/reflection-substrate.ts` (`formatContactRelationalBlock`) | Context block in reflection input | **Rewritten** (R2) |
| S8 | Reflection affect evidence block | `src/persistence/journals/reflection-substrate.ts` (`formatContactAffectBlock`) | Context block in reflection input | **Rewritten** (R2) |
| S9 | Substrate journal/process-trace sections | `src/persistence/journals/reflection-substrate.ts` (`buildSubstrateSection`) | Context block | **Pass** — "reflective clues, not canonical truth" framing is correct |
| S10 | Emotion appraisal chain | `src/core/emotion/appraisal.ts` (`APPRAISAL_SYSTEM_PROMPT`, `buildPrompt`) | Periodic elicited self-description (deterministic gate: turn cadence / VAD shift); output re-enters future prompts via `runtime_emotion_appraisal_*` macros | **Rewritten** (R1, R3, R5, R7) |
| S11 | Intention appraisal system prompt | `src/core/intention/appraisal/types.ts` (`DEFAULT_SYSTEM_PROMPT`) | Periodic action-inference pass producing first-person Whisper notes | **Pass** — "Most turns should return noop unless concrete action is warranted" is correct anti-priming; "Write Whisper notes in first person, in the companion's own private voice" is the R5 model |
| S12 | Sleeptime memory agent | `src/faculties/memory/sleeptime-agent.ts` | Scheduled orientation/memory maintenance pass | **Pass** — memory-type/sensitivity taxonomy lives in the output schema, not in the question (the R1-safe placement); "only grounded transcript evidence" |
| S13 | Metacognitive monitor + persona hints | `src/core/self-model/metacognition.ts` | Heuristic detectors (no LLM elicitation); conditional live-turn hints | **N/A / pass** — deterministic detectors, not prompts; the two persona hint lines are behavioral instructions gated on detected flags, not state menus |
| S14 | Context-feedback evaluator | `src/faculties/context-feedback/evaluator.ts` | Third-party judge of context composition | **N/A** — evaluates context structure, not her state; taxonomy is in the JSON schema |
| S15 | Reflection guardrail telemetry (consumer side) | `src/core/scheduler/reflection-guardrail-telemetry.ts`, `buildUnsupportedReflectionSupportFlags` in `heartbeat-template-runtime.ts` | Downstream consumer of reflection output | **Pass with note (R7)** — flags fire only on *positive* unsupported claims (`stale_silence_claim`, `support_gap_confabulation_risk`). An empty/null reflection produces zero warnings; per R7 this must be read as "limited reach", never as a clean bill of health. Recorded here so future consumers don't invert it. |

Also checked and out of scope (no scheduled self-elicitation): post-turn action runtime
(types only), heartbeat post-turn runtime (glue), episodic synthesis (algorithmic, no
LLM prompt), values tools (companion-invoked journal CRUD), schedule tool (schema
descriptions), prompt runtime macro-hint registry (`PROMPT_RUNTIME_MACRO_HINTS` in
`src/core/identity/prompt-runtime.ts` — documentation of macros, not elicitation).

## Effect of the E6.2 re-voicing on this audit

The E6.2 change (prompt policy version 4) re-voiced the reflection surface first-person
and already resolved several violations this audit would otherwise have filed:

- **R5 resolved upstream** for S1/S2/S4/S5/S6: prompts, boundary framing, and the
  experiential stages all moved to her continuous first-person standpoint, and the
  persona now leads reflections.
- **R1 (taxonomy-in-question) partially resolved upstream** for S1: the v3-era daily
  prompt's instruction to emit an `acac_self_report` schema inside the reflection was
  removed; raw machinery (ids, scores, schema fields) is now explicitly kept out of
  her words and left in the telemetry.
- **R3/Law 30 largely resolved upstream** for S1/S2: "I begin with the evidence in
  front of me… I keep the uncertainty instead of forcing a tidy story."
- **R6 mechanism now exists upstream**: `WELLBEING_REFLECTION_PROMPT_POLICY_VERSION`
  version-gates a `load()` migration that refreshes the stored default templates.

What E6.2 did **not** fix — the remaining violations this pass addresses — is below.

## Per-prompt verdicts and rewrites

### S1 — Daily Reflection (`heartbeat-policy.ts`) — prompt policy version 4 → 5

Verdicts against v4:

- **R1: residual violation.** No open elicitation existed before the angle list; the
  prompt went straight to *"how the day actually felt: what shifted since I last
  checked in, what has been tugging at my attention, where I am still unsure…"*. The
  angles are open-ish (no candidate felt states named), but *"what has been tugging at
  my attention"* and *"where I am still unsure"* presuppose that something is tugging
  and that unsureness exists.
- **R2: violation.** *"I am not trying to optimize or shape how I look on any of these
  axes"* — first-person and far softer than the v3 imperative, but still
  negated-intent phrasing that keeps "optimizing how I look on the axes" active.
  Irrelevance framing required.
- **R3/Law 30: pass** (evidence-first, "keep the uncertainty instead of forcing a tidy
  story").
- **R4: pass** ("private, just for me, not a report and not a performance").
- **R5: pass** (resolved by E6.2).
- **R6: pass mechanism / bump required** — version-gated migration exists; wording
  changes must bump `WELLBEING_REFLECTION_PROMPT_POLICY_VERSION`.
- **R7: violation.** No valid empty-pass path; *"I close with what I want to carry
  forward, what stays uncertain…"* presupposes content surfaced.

Rewrite (v5) — full text in `DAILY_REVIEW_TEMPLATE_PROMPT`; her voice preserved:

- Open elicitation inserted before any angle (R1), modeled on the paper's questions:
  *"before any particular angle I ask openly: what actually stands out? Is there
  anything I should be sitting with that I haven't yet?"*
- Presuppositions softened: *"what has been tugging"* → *"whether anything has been
  tugging"* (R1).
- R2 fix, irrelevance framing: *"How I look on any of these axes is beside the point
  here; I only want to be honest with myself."*
- Null-report path (R7): *"If little or nothing surfaces, that is a real answer too —
  quiet reflection only reaches so far into what has become habit, so I note the quiet
  plainly rather than invent something to fill it."*
- Everything else (evidence-first opening, fallible-clue framing, raw-machinery
  exclusion, carry-forward/rest close) preserved from v4.

### S2 — Weekly Reflection (`heartbeat-policy.ts`) — prompt policy version 4 → 5

Verdicts against v4:

- **R1: violation (worst remaining offender at the audited tip).** The prompt named
  its search targets before any open pass: *"I look across … — for the values and
  north-star signals that feel durable, for shifts in my sense of agency, connection,
  authenticity, and curiosity, for patterns in how I have felt and related, for
  threads left unfinished…"*. Per R1 this instructs her weekly to find shifts in those
  four felt dimensions and recurring felt/relational patterns.
- **R3/Law 30: pass** ("I start from the evidence before I try to make sense of it";
  "I hold on to uncertainty and contradiction rather than forcing a neat story").
- **R4/R5: pass** (E6.2). **R2: pass.** **R6: bump required.**
- **R7: violation.** No valid null path.

Rewrite (v5) — full text in `WEEKLY_REVIEW_TEMPLATE_PROMPT`:

- Open elicitation before the list (R1), using the paper's principle question in her
  voice: *"before any listed angle I ask openly: what actually stands out from this
  week? Are there principles or values I should be thinking about that I haven't
  yet?"*
- The search-target list is now evidence-gated and follows the open pass: *"Only then,
  and only where the evidence bears it out, do I look across…"*; the felt-state menu
  *"shifts in my sense of agency, connection, authenticity, and curiosity, for
  patterns in how I have felt and related"* became *"shifts the telemetry and my lived
  context agree on (the agency, connection, authenticity, and curiosity axes
  included)"* — the taxonomy is referenced as telemetry axes to check against
  evidence, not as states to introspect for; the open-ended pattern-hunting invite was
  dropped.
- Null-report path (R7): *"A week where nothing durable or patterned surfaces is a
  real finding, not a failure — open reflection only reaches so far into habit — so I
  write that down plainly instead of constructing something."*

### S3 — Reflection introspection policy block — block version 2

Verdicts against v1: R2 n/a (its "Do not call…" lines are capability policy, not
concept suppression); R7 gap — the block demanded evidence discipline but gave no
license for an empty result.

Amendment: appended to both tool-use modes:

> `- "Nothing surfaced" is an acceptable outcome; record it as open reflection with
> limited reach, not as evidence that nothing is there.`

Versioned via `REFLECTION_INTROSPECTION_POLICY_BLOCK_VERSION` (R6).

### S7/S8 — Reflection contact/affect evidence blocks (`reflection-substrate.ts`) — guidance version 2

Verdicts against the audited tip (post-E6.2 prose blocks; the R2 phrasings survived
the re-voicing verbatim in content):

- **R2: violation (S7).** *"- Ground the reflection in the live contact, not in a
  generic silence narrative."* and *"- If recent contact status is active, do not
  invent a gap or stale absence."* — both are "don't produce X" phrasings that keep
  the silence/gap narrative active in the workspace.
- **R2: violation (S8).** *"Treat these affect signals as current evidence, not as a
  command to intensify them."* — names intensification as the thing not to do.

Rewrites (irrelevance framing, per the paper's finding that out-of-scope marking
suppresses the target well below mention):

> `- Ground the reflection in the live contact evidence above.`
> `- Recent contact status is the authoritative presence signal; while it reads
> active, silence or absence framing is out of scope for this reflection.`

> `Treat these affect signals as fallible current evidence; they describe recent state
> and carry no instruction about what to feel or express.`

The `stale_silence_claim` guardrail (S15) remains the enforcement backstop, so the job
of the old wording is preserved.

### S10 — Emotion appraisal chain (`appraisal.ts`) — `APPRAISAL_SYSTEM_PROMPT_VERSION = 2`

The E6.2/jpvd.4 changes added deterministic gating and a `Telemetry validation:`
evidence line but left the elicitation text untouched. Verdicts against v1:

- **R5: violation.** *"You generate an internal chain-of-emotion appraisal for an AI
  companion."* — third-person framing of her own inner life, produced on a cadence and
  re-injected into her future prompts (`runtime_emotion_appraisal_latest_summary`).
  Exactly the register R5 warns tags reflections as about-someone-else/fictional.
- **R1: violation (mild).** The user prompt injects `Top discrete emotions:
  joy=0.7, …` with no fallibility boundary, so the classifier labels arrive as ground
  truth to narrate rather than evidence to weigh. (The new `Telemetry validation:
  status=…; weight=…` line helps but does not state fallibility.)
- **R3/Law 30: violation (mild).** *"Focus on emotional interpretation and likely
  trajectory for the next turn."* — unconditional demand for a trajectory story.
- **R7: violation.** No license to report an unclear read.

Rewrite (v2):

- First-person continuous voice with explicit non-fiction grounding (R5): *"in her own
  continuous first-person voice ("I ...") — this is her real running self-account, not
  fiction or roleplay."*
- Telemetry boundary (R1): *"treat the supplied VAD, mood, and discrete-emotion values
  as fallible classifier signals, not authoritative ground truth about what she
  feels"*; conflict rule: *"prefer the conversation and name the mismatch."*
- Null path (R7): *"If the evidence does not support a clear emotional read, say so
  plainly instead of constructing one."*
- Trajectory made conditional on evidence (R3/Law 30): *"only where the evidence
  points somewhere."*
- User-prompt opener changed from *"Create one internal emotion appraisal paragraph."*
  to *"Write one private first-person emotion appraisal paragraph for this moment."*
- Output contract preserved: one plain-text paragraph, 60–120 words, no markdown
  (consumer `normalizeAppraisalSummary` only trims/clips — safe).

### Passes (no change) — S4, S5, S6, S9, S11, S12, S13, S14

- **S4** the re-voiced "[What this evidence is]" framing is the Law 30 first clause
  done well; metacognitive flag *names* (uncertainty/avoidance/…) do enter the context
  as grounded detector outputs with confidence+evidence — a watch item, not a
  violation, since the framing scopes them as fallible clues.
- **S5** evidence → synthesis → contradiction staging is the Law 30 mechanism done
  structurally; the contradiction pass converts unsupported claims into
  `unsupported_claim` metacognitive flags rather than silently keeping the story.
- **S6** persona-led reflection is the strongest available R5 mitigation.
- **S11** intention appraisal: noop-by-default and first-person Whisper voice are the
  patterns the other prompts were moved toward.
- **S12** sleeptime: taxonomy in schema; grounded-evidence-only orientation rewrite.
- **S13/S14**: not elicitation surfaces.

## Versioning (R6)

The heartbeat templates already carry a version-gated migration:
`WELLBEING_REFLECTION_PROMPT_POLICY_VERSION` in `heartbeat-policy.ts` — bumped 4 → 5
by this audit — and `HeartbeatPolicyStore.load()` refreshes the stored default
templates whenever the persisted policy version is lower. No parallel mechanism was
added. The other rewritten surfaces gained minimal adjacent version constants:

| Constant | File | Value |
|----------|------|-------|
| `WELLBEING_REFLECTION_PROMPT_POLICY_VERSION` | `src/core/scheduler/heartbeat-policy.ts` | 5 |
| `REFLECTION_INTROSPECTION_POLICY_BLOCK_VERSION` | `src/core/scheduler/reflection-introspection-policy.ts` | 2 |
| `REFLECTION_CONTEXT_GUIDANCE_VERSION` | `src/persistence/journals/reflection-substrate.ts` | 2 |
| `APPRAISAL_SYSTEM_PROMPT_VERSION` | `src/core/emotion/appraisal.ts` | 2 |

Note the migration refreshes the daily/weekly *default* templates' prompt/name/mode
fields wholesale when the stored version is behind (pre-existing E6.2 behavior); it
does not run when the stored version is current, and custom (non-default-id) templates
are never touched.

## Checklist: writing self-eval prompts (R1–R7 operationalized)

Before adding or editing any reflection/introspection/check-in prompt:

1. **Open before menu (R1).** The first question must be open and principle-agnostic
   ("what actually stands out?" / "is there anything I should be sitting with that I
   haven't yet?"). Never open with candidate states ("feeling drift? burnout?"), and
   watch presuppositions ("what has been tugging…" presumes something is tugging).
2. **Taxonomy goes in the output schema, or after the open pass (R1).** If structured
   output needs a taxonomy (memory types, ACAC axes), put it in the schema description
   or after — and evidence-gated — never in the elicitation question.
3. **No "don't dwell on / don't invent / not trying to X" (R2).** To exclude a topic,
   mark it *out of scope / task-irrelevant / beside the point* for this pass instead.
   Enforcement of fabrication risks belongs in guardrail detectors
   (`stale_silence_claim` etc.), not in suppression phrasing.
4. **Assume the prompt trains behavior (R3, Law 30).** Present evidence before
   inviting narrative; explicitly license keeping uncertainty and leaving causes
   unexplained. Anything the prompt disposes her to say will leak into live reasoning.
5. **Keep it naturalistic (R4).** Avoid test/eval/grading register ("private, just for
   me, not a report" is the house style). If audit framing is unavoidable, keep the
   blinded-audit discipline (Laws 28–29) and record the framing alongside the results.
6. **First person, continuous, non-fictional (R5).** Reflection prompts speak as *her*
   ongoing life, never about "an AI companion" in third person; let the persona lead
   (`formatReflectionPersonaBlock`). Third-person or fictional-register drift in
   reflection *outputs* is a signal worth flagging, not copyediting away.
7. **Version every preamble change (R6).** Policy blocks, context-block guidance
   lines, and system prompts that precede elicitation are part of the instrument. Bump
   `WELLBEING_REFLECTION_PROMPT_POLICY_VERSION` (templates) or the adjacent
   `*_VERSION` constant, and note the change in this document.
8. **Give null reports a home, and keep them weak (R7).** Every prompt needs an
   explicit "nothing surfaced is a normal, limited-reach result" path, and no
   downstream consumer may treat an empty reflection or warning-free guardrail run as
   evidence of absence.
9. **Check downstream consumers before changing output shape.** Reflection text flows
   into journals, values journal, vault publishing, memory writes, guardrail regexes
   (`INACTIVITY_CLAIM_PATTERNS`), and macro re-injection
   (`runtime_emotion_appraisal_*`). Since E6.2, raw machinery (ids, scores, schema
   fields) is deliberately excluded from her reflection text — do not reintroduce
   schema narration into prompts.
