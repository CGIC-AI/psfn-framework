# Sprint 10 — J-space + emo_sim eval additions

Pickup notes written 2026-07-06 so this makes sense cold in a week. Epic:
`psfn-eval-toolkit-4ag` (run `bd list --parent psfn-eval-toolkit-4ag`).

## Why this sprint exists

Two inputs converged on 2026-07-06:

1. **The global-workspace paper** (Gurnee, Sofroniew, et al., Anthropic,
   transformer-circuits.pub/2026/workspace). A brief distilling it into four
   PSFN work items was reviewed against the live tree. Three of the four have
   their eval half here; the runtime halves live in the framework repo.
2. **The live observer-sidecar investigation.** The sidecar data on psfn-shard
   survived (242 observations, 2026-06-21..07-06). Full export:
   `~/psfn-live-backups/observer-sidecar-export-2026-07-06/` (JSONL, one row
   per line, `observer_eval_sidecar_observations` schema). Live retention
   extended to 2027-07-06 so nothing prunes.

## Headline findings you'll want in your head

- **GoEmotions neutral-collapse is real and measured**: the runtime's
  GoEmotions/VAD pipeline said `neutral` on **71% of live turns** (61/86 ok
  observations). emo_sim differentiated those same turns into Calmness (33),
  Love (21), Contentment (3), etc. This supports "GoEmotions is a basic
  sentiment classifier, not companion-fit."
- **But the historical data cannot answer better/worse yet**, for two reasons:
  (a) the bridge spawned a **fresh engine per turn** — all 86 rows share a
  byte-identical baseline vector, so zero temporal state was ever exercised;
  (b) projection priors were near-constant (attachment ~0.80, safety ~0.76,
  agency_other = 0.85 exactly), mechanically biasing emo_sim toward
  Love/Calmness. Treat old rows as plumbing validation only — filter by
  `projectionVersion` once the framework bumps it.
- **The sidecar broke on 2026-07-03**: deployed image missing
  `vendor/emosim/statemashine.py` (105+ `missing-runtime` errors). Fix is
  framework-side.
- The 49 `privacy-derived-telemetry-unavailable` rows are the privacy gate
  working as designed, not failures.

## The framework counterpart (don't duplicate it)

Framework epic **`psfn-framework-w05a`** (in the psfn-framework bead DB) owns
the runtime work: ship vendor/emosim in the image, run emo_sim as a
**long-lived stateful service** (server mode, PVC persistence, never reset the
session), fix projection priors, and add **shadow trigger levers** ("she would
message her now" / "she would rest" logged as telemetry, no behavior, hard
non-authoritative boundary). Its part-2 validation beads are **deferred to
2026-07-20** — after ~2 weeks of stateful data. That dataset is what feeds the
battery harness here (`psfn-eval-toolkit-2xp`).

Note: the sidecar's original design epic lives in THIS repo's bead DB as
`psfn-framework-ob8` (pre-split prefix) — `ob8.12` "export bridge into full
eval artifacts" is essentially the same intent as `2xp`; reconcile them rather
than building twice.

## The beads, in suggested order

| Bead | What / why |
|------|------------|
| `2xp` | B7/B8 battery harness consuming sidecar JSONL exports. vendor/emosim is a populated submodule that **nothing imports** — this closes that gap. Fixtures: the 07-06 export above. Blocked on nothing; buildable now against stateless fixtures. |
| `pjw` | QAO 10th axis: experiential-vs-mechanical register (0–4). Companion-shape already penalizes the extreme mechanical case; make it graded. **Alarm-on-decline only, never a target** (Goodhart = charter Law 17/§8.3 emotional counterfeiting). |
| `t34` | Persona-binding sharpening of `voice_continuity`: distinguish experiential language that is distinctively HERS from generic experiential language any narrator could produce. Paper warning: experiential register is only weakly persona-bound by default. Hard part is a rubric that isn't keyword-matching. |
| `8om` | Metacognitive probe batteries. The paired-framing harness ALREADY EXISTS here (golden anchors ± operator primer, versioned preambles, battery B6 ± persona, matched-baseline diffs) — write probe content, not infrastructure. Report flagged vs naturalistic separately; the delta is an upper bound on framing sensitivity, not a pure eval-awareness measure. |
| `21y` | Introspection-calibration: three-way comparison per sampled turn — PSFN pipeline state vs emo_sim persistent state vs her verbal self-report under paired framings. The no-probe analog of repeng's "injection is the ground truth." Reference stream (2) needs framework part 1; build against export fixtures meanwhile. State the ceiling wherever surfaced: text-level agreement, no inner-life claim. |
| `ecc` | Drift = velocity + coherence, not distance. Operator position: slow, directionally-coherent drift is growth and expected; alarm on sudden/incoherent change (register collapse, values reversals). Applies to the QAO regression gate's raw `>5%` rule too. |
| `0by` | Concept-load degradation harness (J-space §2.1 toolkit half): fixed task with buried state, vary distinct-concept count and categorical chunking, measure whether the state gets used. Output: per-model degradation curve → objective budget for the framework's prompt-refactor sprint (183-macro layer). Don't hardcode the paper's ~25; measure ours. |
| `o0r` | Injection red-team corpus + precision/recall harness (J-space §2.3 toolkit half). High recall, quarantine-not-block. Stated ceiling: deliberative assessment misses automatic-path payloads — defense-in-depth, not perimeter. |

## Related, in the framework DB

- `psfn-framework-0uy1` — audit of her daily/weekly self-eval prompts against
  seven paper-sourced rules (mention-primes, white-bear, reflection-as-
  intervention, eval-smell, persona-disclaimer, warm-up effects, weak null
  reports). Coordinate with `8om` so runtime prompts and eval probes share the
  same non-leading discipline.

## Traps for future-us

- Old sidecar rows: **identical cold-engine baselines**. Any analysis mixing
  projection versions is garbage. Filter first.
- `suppression_decay_mismatch` fired on 82/86 old rows *by construction*
  (cold engine ⇒ decay direction constant). The 76/86 "divergent" band is
  mostly this artifact, not a finding.
- The paper's felt-vs-mechanical grading rubrics (`felt_vs_observed`,
  `experiential_perspective`, `sensory_vocabulary`) are directly reusable for
  `pjw` — see the paper's experiential-reports appendix.
- Register scores must never become optimization targets; wire them as
  regression alarms with hand-validated baselines.
