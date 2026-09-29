# Laya as a possible local decision backend

Assessment date: 2026-09-29. Status: research only; possible future work.
Future evaluation: **psfn-framework-dz0oo** (P4/backlog).
Report delivery: **psfn-framework-p6lb5**.
Related delivered work: **psfn-framework-4lf3r** (Jev integration).

## Recommendation

Evaluate Laya as an optional, explicitly identified decision backend alongside
Jev and the existing background-model path. Start with short, narrowly scoped
decisions and decide adoption separately for each site. An evaluation may
conclude that no integration is justified.

The appealing properties are open weights, local inference, and typed outputs.
The unresolved question is whether particular checkpoints are accurate,
calibrated and fast enough for PSFN's actual decision inputs. API compatibility
does not establish equivalent decision quality.

This report reviews primary upstream documentation and PSFN source at
`4f131d336f1597fd1c6805b73168cb1f790ca1c0`. It does not include an installation,
inference benchmark, paid API comparison or deployment test. The linked X post
was inaccessible directly; its claims are not treated as independently verified
evidence.

## What is available

Laya produces typed decisions without generating prose: `noul` (yes/no),
`choice`, and ordinal `score`. Its code and model weights are published under
Apache-2.0. The upstream Python package provides a standalone HTTP server via
the `serve` extra, exposing `POST /v1/systemone`. Unsloth Desktop is therefore
one serving option, not a required PSFN dependency.
[Upstream project](https://github.com/NandhaKishorM/laya),
[code license](https://github.com/NandhaKishorM/laya/blob/main/LICENSE),
[weight license and model card](https://huggingface.co/convaiinnovations/laya).

Unsloth documents CPU and GPU operation on Linux, macOS and Windows, with these
resource estimates:

| Checkpoint | Download size | Minimum system RAM | Intended use |
| --- | --- | --- | --- |
| Multilingual | 678 MB | 4 GB | General multilingual decisions |
| English | 846 MB | 5 GB | English decisions |
| Typed decisions | 846 MB | 5 GB | Specific trained workflows |

Unsloth reports a 10–20 second first model load and warm requests below a second
on most CPUs. These are vendor estimates, not measurements on PSFN's target
hardware; multiple resident models and concurrent workloads need separate
measurement. Local serving permits inference without a hosted decision API,
after required artifacts are available locally.
[Unsloth guide](https://unsloth.ai/docs/models/decision-laya).

For a possible framework integration, prefer the standalone server initially:
it gives the evaluation an explicit endpoint and model lifecycle without
requiring a desktop UI. Pin both the package and downloaded weight revisions
before any experiment; an alias such as `laya` alone is not reproducible model
identity.

## Compatibility with the existing framework

The current source already offers a useful integration boundary, but changing
only the JEV base URL would not work correctly.

| Area | Verified PSFN behavior | Consequence for a future Laya integration |
| --- | --- | --- |
| Transport | Gateway calls OpenRouter's `/api/alpha/decisions`, using OpenRouter credentials and provider preferences. | Add an explicit `/v1/systemone` transport and service configuration. Do not repurpose OpenRouter's provider configuration. |
| Typed answers | A shared validator accepts `noul`, `choice` and `score` answers and rejects invalid answer sets. | Reuse that validator, with recorded Laya fixtures proving the response mapping. |
| Model identity | Settings require a pinned `typesafe/jev-<major>.<minor>` identifier; the transport checks the returned model. | Introduce Laya-specific artifact identity and validation instead of weakening Jev's checks. |
| Backend identity | Modes are `local`, `jev`, `shadow`; outcomes and comparison records identify Jev explicitly. | Represent Laya distinctly in settings, outcomes, probability provenance, telemetry and comparison records. |
| Local path | The generic local backend uses the configured background model; existing sites may supply their original local strategy. | Preserve that path and each site's safe failure behavior. Laya should remain optional. |
| Privacy | Companion-private sites/calls are forced through the existing local path. | A same-host HTTP service is still a separate process. Do not relax this boundary just because its endpoint is local. |
| Evaluation | Existing tools cover labeled decisions, calibration, latency and shadow comparisons. | Extend those tools to accept a Laya backend; current `--local-endpoint` support expects an OpenAI-compatible model. |

Source evidence:
[gateway service](../../src/boundary/gateway/jev-decision-service.ts),
[Jev transport](../../src/primitives/llm/decision/jev-transport.ts),
[answer validation](../../src/primitives/llm/decision/answer-validation.ts),
[settings contract](../../src/system/config/decision-backend-config.ts),
[outcome types](../../src/primitives/llm/decision/types.ts),
[decision runtime](../../src/primitives/llm/decision/decide.ts),
[site privacy](../../src/primitives/llm/decision/sites.ts),
[local backend](../../src/primitives/llm/decision/local-backend.ts), and
[evaluation tools](../../scripts/decision-eval/README.md).

## Quality and capacity limits

### Confidence is not interchangeable

Unsloth explicitly warns that Laya and Jev calculate `confidence` differently
and recommends looking at the selected option's probability. That still does
not establish that the probabilities are calibrated on our tasks.
[Migration guidance](https://unsloth.ai/docs/models/decision-laya).

The multilingual model card says it ships without fitted calibration
temperatures and is systematically overconfident. It also identifies ordinal
scores as a weak area, including measured position bias. Fit and validate any
calibration on held-out domain examples before using probability thresholds.
[Multilingual limitations](https://huggingface.co/convaiinnovations/laya-multilingual#limits).

### The headline Jev comparison is not a controlled replacement test

The typed-decisions model card reports 76.6% accuracy versus a published Jev
figure of 72.7%. It also states that the Jev result was not measured by the
project and that prompts and sample sizes differ. The Laya checkpoint was
specialized on four synthetic workflows; the base English checkpoint scored
36.2% on that benchmark. The specialist also has unresolved calibration
caveats. These results justify testing, not a claim that Laya generally
outperforms Jev on PSFN tasks.
[Typed-decisions model card](https://huggingface.co/convaiinnovations/laya-typed-decisions).

### Context and option budgets constrain inputs

The English checkpoint defaults to 512 tokens, with roughly 320 left for state
after its question/options budget. Multilingual and typed-decisions default to
1,024, with roughly 768 for state. Larger choice sets compete for that same
option budget; around 20 described options can already require special care.
[Model limits](https://huggingface.co/convaiinnovations/laya#honest-limits).

The multilingual upstream API can extend its token limit to 8,192, but its card
reports variable long-document accuracy. This must be tested on the exact
serving surface; it is not evidence that every Unsloth request uses that limit.
[Multilingual context support](https://huggingface.co/convaiinnovations/laya-multilingual).

PSFN currently sends the turn and all selected candidate memories together for
`memory.rerank`. That payload can outgrow these defaults. A future adapter must
detect or report truncation and prove that the relevant state reaches inference;
successful JSON responses alone are insufficient.
[Retrieval decision inputs](../../src/faculties/memory/retrieval/decision-routing.ts).

### Negation needs explicit adversarial examples

Upstream documents a small cancellation reproduction in which negated requests
selected cancellation, including one probability of 0.9998. This is a specific
failure case, not a measured universal failure rate.
[Upstream issue 377](https://github.com/NandhaKishorM/laya/issues/377).

Include negation, quoted instructions and conflicting evidence in evaluation.
Do not initially grant Laya action authorization or replace security screening.
Those would require evidence beyond routing accuracy.

## Bounded future evaluation

The backlog bead owns the work below. It is an investigation, not approval to
change runtime defaults or live deployment configuration.

1. Select exact package and weight revisions and an explicitly identified test
   environment. Record CPU/GPU, memory use, cold load and warm p50/p95 latency.
2. Extend the existing bakeoff with invented, public-safe examples. Begin with
   short `memory.query_intent` and/or `room.ambiguity` decisions. Confirm each
   selected site's runtime wiring in the intended environment before rollout.
3. Compare against the existing local baseline. A paid live Jev comparison is
   a separate authorized experiment; published benchmark numbers are not a
   substitute for matched prompts and cases.
4. Measure correctness, false positives/negatives, calibration, latency and
   oversized-input behavior per site and checkpoint. Include negation, missing
   evidence, long state, label ambiguity and service failures. Specify pass/fail
   criteria before selecting an adoption verdict.
5. If promising, propose a scoped implementation using the existing decision
   primitive, shared validation, owner-file configuration and Garden exposure.
   Extend shadow comparison to identify Laya correctly; retain the baseline's
   decision while collecting comparisons and preserve private-site isolation.
6. Record **adopt**, **shadow only**, or **reject** per site. Create an
   implementation bead only where results justify it. An evaluation can finish
   successfully with a rejection or a recommendation to fine-tune first.

No security-site rollout, global Jev replacement, deployment change, automatic
activation, or model download is part of this report. Private evaluation data
must remain outside Git; only invented fixtures and public-safe results belong
in the framework repository.
