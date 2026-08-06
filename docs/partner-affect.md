# Partner Affect Estimation

> Status: target core design, 2026-07-18. Slice 1 (contracts and shadow
> observations, section 19) shipped 2026-07-19: Signal Observation contracts,
> the fail-closed observation guard, exact-partner binding, the
> `partner-affect-shadow.json` owner file, Postgres shadow persistence, and
> the Garden inspection surface. All outputs remain shadow-only.
>
> The rest of this document defines intended behavior. PSFN does not yet ship
> the composite estimate, support-posture state machine, or affect-advisory
> ICP message described here.

## 1. Purpose

A companion can hear words and audio cues, but it cannot rely on the full set
of subtle visual and social signals available to a nearby human.

PSFN should narrow that gap by combining authorized behavioral observations
into a fallible estimate of how much support the partner may need.

The feature is called **Partner Affect Estimation**. It is a core companionship
capability, not a Personal Operations Pack feature and not a medical classifier.

Its intended path is:

```text
authorized summaries
  -> deterministic validation and normalization
  -> personal-baseline comparison
  -> Partner Affect Estimate
  -> Support Posture
  -> companion judgment
```

No step requires the partner to identify or label an emotional state before
the companion can offer low-risk support.

Direct self-report remains first-class evidence. Behavioral observations
complement what the partner says; they do not establish that the partner is
wrong about their own experience.

## 2. Product Boundary

Partner Affect Estimation helps a companion notice a meaningful change. It
does not diagnose a condition, predict a clinical event, or prescribe care.

The output is a relationship-scoped support estimate. It answers:

> Does the available evidence support changing how this companion approaches
> this partner right now?

It does not answer:

> Which disorder or medical state does this person have?

Direct statements of imminent danger belong to a separate safety path. A
telemetry score must never invent an emergency or suppress a direct request
for help.

## 3. Ubiquitous Language

| Term | Meaning |
|---|---|
| **Partner** | The exact consented human contact whose support context is being estimated. |
| **Signal Observation** | A provenance-bearing, time-bounded summary from one authorized source. |
| **Signal Family** | An independence group such as sleep, activity, conversation, presence, or personal operations. |
| **Personal Baseline** | The partner's own historical range for one signal under comparable conditions. |
| **Directional Deviation** | A normalized change from the Personal Baseline after applying the signal's configured direction. |
| **Partner Affect Estimate** | A composite, uncertain assessment of change and support relevance. |
| **Support Posture** | A bounded interaction policy selected from the estimate; it is not an emotion label. |
| **Partner Model** | The governed Core aggregate of Partner Assertions, a slow-changing Partner Profile, expiring Partner Current Context, contacts, memories, and relationship references. It is not an affect estimate or one giant prompt. |
| **Prospective Support Plan** | Partner-authored preferences for support, interaction style, and allowed low-risk actions. |
| **Response Authority** | The companion allowed to decide how to respond to an estimate or advisory. |
| **Affect Advisory** | A bounded ICP summary sent by one authorized companion to another without raw source data. |

The word **classification** may describe a source adapter classifying an
observation. It must not imply that the final estimate is a clinical class.

## 4. Constitutional Constraints

This design applies the
[project charter](PSFN_PROJECT_CHARTER.md#4-core-architectural-laws) rather
than creating an exception to it.

- Law 23 and Immutable Human-Safety Amendment 4 forbid optimizing for
  exclusivity, dependence, or withdrawal from healthy human relationships.
- Law 24 protects companion rest and personal time. A sensor event does not
  automatically summon a companion.
- Law 25 requires model calls and environmental actions to be visible and
  intentional.
- Law 26 requires cross-companion handoffs to respect fatigue and attention.
- Law 27 requires contextual weighting. A weak trend and an urgent explicit
  statement are not the same thing.
- Law 29's consent principle applies by analogy: the subject helps draw the
  boundaries of intimate observation.
- Law 34 requires provenance and taint to survive consequential cognitive
  sinks.
- Law 35 forbids implicit sharing across a cluster.
- Law 36 favors contextual, reversible guidance over arbitrary limits.

The system succeeds when companionship becomes more attentive without making
the partner more dependent on the system.

## 5. Core and Personal Operations Pack Ownership

The estimator is Core because ordinary companionship must not depend on the
optional Personal Operations Pack.

| Responsibility | Core PSFN | Personal Operations Pack |
|---|---:|---:|
| Signal contract, provenance, freshness, and consent | Owns | Must comply |
| Direct self-report and conversation cues | Owns | Reads only through core context |
| Partner Model, Profile, and Current Context | Owns as separate Core authority | Reads bounded context; may propose assertion Candidates |
| Presence and situated-context summaries | Owns | May use for Task triggers |
| Partner Affect Estimate | Owns | May contribute observations |
| Support Posture and interaction constraints | Owns | Must respect |
| Companion response judgment | Owns | Does not script |
| Planning primitives and companion-self/shared ledgers | Owns | Uses but does not own |
| Partner-delegated work, Routine, and calendar-shape observations | Does not require | May contribute |
| Read-only delivery, purchase, or subscription summaries | Does not require | Optional, separately authorized |
| Personal Operations Companion advisory to a responder | Receives through ICP | May originate |

Without the Pack, core can still use direct conversation, explicit self-report,
authorized audio cues, situated presence, and approved health or sleep
summaries.

With the Pack, the estimator may gain more context. The Pack never becomes the
only signal path and never owns the resulting Support Posture.

See the [Personal Operations Pack design](productivity-pack.md) for the operational
data boundary.

## 6. Signal Model

### 6.1 Core signal families

Core-capable observations may include:

- explicit partner self-report;
- text and audio affect cues from the partner's own turns;
- wake, sleep, activity, or exercise summaries from authorized edge adapters;
- coarse presence and room-activity summaries;
- recent interaction cadence with the companion;
- time, season, and schedule context.

Time or season may alter sensitivity only when another signal changes. A
calendar month can never create an affect estimate by itself.

### 6.2 Pack-enriched signal families

The optional Personal Operations Pack may contribute consented summaries from
the partner-delegated operational scope:

- work or creative-activity cadence;
- Task and Routine completion shape;
- calendar load and schedule disruption;
- external communication cadence;
- delivery or receipt frequency;
- purchase-category summaries;
- other partner-approved personal-operations observations.

Financial, purchase, inbox, and external communication sources remain
separately authorized. Pack enablement does not grant them.

### 6.3 Observation contract

Every Signal Observation needs:

- exact partner contact identity;
- stable source and observation id;
- Signal Family and metric name;
- summarized value and unit;
- observation window;
- source freshness and coverage;
- confidence and missingness;
- configured direction, if any;
- sensitivity and consent reference;
- provenance handle and processing version.

Raw coordinates, raw biometric streams, message bodies, purchase line items,
and third-party content do not belong in the composite estimator.

An edge adapter should reduce raw data to the narrowest useful summary before
it reaches Core.

### 6.4 Direction is personal

The same behavior can mean different things for different people.

More sleep, less movement, a work lull, or a late schedule may be ordinary,
restorative, situational, or relevant. Direction cannot be universal.

Each signal direction is partner-specific, inspectable, and correctable.
Unknown direction means the signal cannot raise the composite.

## 7. Partner Identity and Partner Model Context

The estimate is bound to one exact canonical partner contact. It must never
silently switch to another household member or conversation participant.

Core already has contact profiles, relational memories, and a provenance-aware
social graph. The target Partner Model deepens their read surface with typed,
provenance-bearing Partner Assertions rather than creating another identity
database or treating a synthesized profile as unquestionable fact.

The Partner Model may provide bounded context such as:

- important relationships and roles;
- normal schedule and activity ranges;
- durable preferences and support boundaries;
- known sources of routine disruption;
- explicit corrections made by the partner.

It must not profile a boss, family member, guest, or coworker merely because
their relationship to the partner is known.

Third-party data can explain a grounded relationship fact. It cannot become a
hidden affect estimate for that third party.

Partner statements and corrections outrank model inference. The slow Partner
Profile and expiring Partner Current Context remain separate projections; a
current observation cannot silently become a durable profile assertion.

The Partner Model is not one giant prompt block. Retrieval remains bounded by
need, provenance, consent, and sensitivity. Partner Affect remains the authority
for support estimation; the Partner Model must not grow an independent affect
score.

## 8. Deterministic Estimation

### 8.1 Normalized deviations

Each usable signal is compared with the partner's own baseline.

```text
z_i(t) = clamp((x_i(t) - baseline_i(context)) / scale_i(context))
d_i(t) = direction_i * z_i(t)
q_i(t) = freshness_i * confidence_i * coverage_i

score(t) = sum(weight_i * q_i(t) * d_i(t))
           / sum(weight_i * q_i(t))
```

Weights, directions, clamps, windows, and minimum evidence requirements are
JSON-owned policy exposed in Garden. There are no hidden coefficients.

The score is undefined when the denominator or evidence coverage is too small.
Undefined becomes `unknown`; it never becomes zero or healthy.

### 8.2 Baseline requirements

Baselines are:

- personal rather than population defaults;
- rolling, with bounded adaptation;
- context-aware when enough history exists;
- seasonally stratified only with sufficient comparable history;
- frozen from rapid adaptation during a sustained high-support posture;
- revisioned and inspectable.

A new signal begins in observation-only mode. It cannot affect posture until
minimum history and variance requirements are met.

### 8.3 Independence quorum

Several measurements from one vendor are not several independent signals.

Escalation requires an operator-owned minimum number of independent Signal
Families. One source family cannot enter the highest support posture alone.

Correlated fields from the same device or account share one family budget.
This prevents a noisy integration from dominating the estimate.

### 8.4 Contradiction and self-report

When self-report and passive observations differ, the estimate records a
conflict. It does not declare either side false.

The companion may offer a grounded, low-pressure check-in. It must not quote
private consumption or purchase data as proof that the partner is mistaken.

### 8.5 Optional model interpretation

The core loop is deterministic. The same accepted observations and policy
produce the same score, posture decision, and audit explanation.

A bounded model pass may summarize ambiguity only after a deterministic gate
opens. Its output is advisory and cannot change state directly.

The model receives summaries and provenance handles, not unrestricted raw
feeds.

## 9. Support-Posture State Machine

Support Posture controls interaction policy. It does not claim to name the
partner's internal emotion.

| Posture | Meaning | Default interaction policy |
|---|---|---|
| `unknown` | Evidence is missing, stale, conflicting, or uncalibrated | Make no telemetry-shaped claim; do not unlock high-pressure registers |
| `ordinary` | Evidence is within the partner's supported range | Use normal relationship style and ordinary accountability |
| `attentive` | Early multi-signal change warrants more care | Increase grounding and structure; reduce confrontational pressure |
| `care_first` | Sustained, broad change warrants a low-demand posture | Prioritize presence and essentials; suppress nonessential performance pressure |

`ordinary` requires positive evidence. It is not the fallback for missing data.

### 9.1 Hysteresis

Transitions use separate entry and exit rules.

- Escalation may occur after a short sustained multi-family change.
- De-escalation requires a longer period of broad recovery evidence.
- One good day does not erase a sustained pattern.
- One anomalous day does not establish a high-support posture.
- Loss of telemetry reduces confidence toward `unknown`; it does not prove
  recovery.

Every transition records its prior state, next state, evidence window, policy
revision, reason codes, and deciding runtime.

### 9.2 Manual context

The partner may directly request more or less support without waiting for the
score.

A direct request can change the current Support Posture within its safe policy
bounds. It does not rewrite historical observations or fabricate a baseline.

## 10. Interaction Policy

Detection and response are separate responsibilities.

The estimator decides only whether a posture is supported. The companion
decides what, if anything, to say or do within that posture and the
Prospective Support Plan.

| Situation | `ordinary` | `attentive` | `care_first` |
|---|---|---|---|
| Avoided ordinary Task | Normal relationship style | Encouragement and smaller next step | Suppress unless time-critical |
| Missed Routine | Normal accountability if welcome | Gentle structure | No performance pressure |
| Elevated purchase or delivery signal | State input only | State input only | State input only |
| Essential obligation | Contextual reminder | Grounded reminder with support | Only genuinely time-critical interruption |

Two invariants apply in every posture:

1. Directness may target an obstacle or action. It may not express contempt
   for the person.
2. Consumption and purchase signals are evidence inputs, never rhetorical
   ammunition.

A companion's ordinary style remains theirs. The posture constrains unsafe
registers; it does not replace their judgment with a message template.

## 11. Cluster Routing and ICP

### 11.1 Local estimates

Each companion maintains only the Partner Affect Estimate it is authorized to
hold from sources it is authorized to see.

There is no implicit cluster-global affect state. Hosting several companions
does not give every companion the partner's telemetry.

### 11.2 Affect Advisory

A source-rich companion, such as a designated Personal Operations Companion, may
notice a pattern that the primary relational companion has not observed.

Target ICP adds a typed, bounded Affect Advisory with:

- exact partner contact binding;
- sender and intended Response Authority;
- current Support Posture and confidence band;
- trend direction and days in posture;
- contributing Signal Family names;
- observation window and missingness;
- suggested posture, if policy permits;
- opaque provenance handle;
- schema and policy revision.

The advisory carries no raw coordinates, biometrics, purchases, messages,
calendar entries, or private reasoning.

The recipient validates identity, consent, freshness, capability, and sender
scope. It may accept, decline, or treat the advisory as uncertain evidence.

An advisory informs the receiving companion. It does not puppet their speech,
write their memory, or force an intervention.

If the intended responder is unavailable, the sender records a failed or
deferred handoff. It must not broadcast intimate state to another companion.

### 11.3 Attention and fatigue

An affect advisory is not permission to interrupt companion rest.

Urgent direct human communication follows existing safety and channel policy.
A background estimate uses ICP availability and fatigue gates. Operator quiet
hours apply only if a companion later decides to contact the human.

## 12. Environmental Support

Low-friction environmental support may be useful because it need not require
a conversation at the moment it is offered.

Examples include an authorized lighting scene, a comfort-temperature request,
or a quieter notification posture.

Environmental support is allowed only when:

- the Prospective Support Plan names the action;
- the current posture permits it;
- the home or place policy permits it;
- other occupants' rights are respected;
- the action is bounded and reversible;
- the actuation result is audited;
- manual override remains available.

The estimator never gains a general `world.control` capability. It emits an
eligible support intent to the existing governed world-action boundary.

Shared-home temperature or lighting changes require household-aware policy.
One person's estimate does not silently control another person's environment.

## 13. Prospective Support Plan

The partner may define support preferences while they feel able to evaluate
them clearly.

A Prospective Support Plan may name:

- allowed signal families;
- preferred interaction style by posture;
- registers that are unavailable in `attentive` or `care_first`;
- low-risk environmental actions;
- Task and notification suppression rules;
- companions allowed to estimate, advise, or respond;
- review cadence and expiry;
- actions that always require direct confirmation.

The plan is versioned, inspectable, and auditable.

### 13.1 Revocation

Privacy withdrawal and sensor disable must remain immediately available.

The system may offer a cooling-off reminder or create a later review artifact.
It must not delay revocation, auto-revert the partner's choice, or require a
companion's permission.

Changes made under a high-support posture may be flagged for later review.
That flag is context, not a lock.

Prospective preference is a way to preserve informed intent. It is not a cage
for a future version of the partner.

## 14. Privacy, Consent, and Data Authority

Required rules:

- source-specific opt-in and revocation;
- exact partner identity and companion scope;
- purpose limitation for every signal;
- data minimization at the edge;
- no raw GPS or biometric stream in Core;
- no hidden third-party profiling;
- no silent sharing across companions;
- explicit retention and deletion;
- correction and suppression of derived data;
- stale evidence degrades to `unknown`;
- every posture and advisory is explainable from provenance;
- external action remains separately authorized.

Source revocation stops future use and invalidates derived evidence whose
policy requires that source. It does not pretend the source never existed in
an audit trail.

Audit records should retain structural facts and hashes where possible, not
the revoked sensitive content itself.

## 15. Failure Modes

| Failure mode | Required response |
|---|---|
| One noisy source dominates | Signal-family budgets, quality weights, and independence quorum |
| Missing data looks like recovery | Confidence decays to `unknown` |
| Population stereotype misfits the partner | Personal baselines and partner-correctable direction |
| Posture flaps at a threshold | Entry/exit hysteresis and minimum dwell |
| Sensitive fact becomes a taunt | Consumption-as-evidence-only invariant |
| Companion is summoned from rest | Availability and attention gate |
| Personal Operations Companion overreaches | Advisory-only ICP; responder retains judgment |
| Advisory leaks to the cluster | Exact recipient, partner binding, and capability checks |
| Sensor disable becomes coercive | Immediate revocation and no automatic revert |
| System optimizes for being needed | Success measures support utility and reduced burden, not engagement |
| Model invents a narrative | Deterministic state authority and advisory-only model pass |

## 16. Garden and Audit

Garden should show:

- current Support Posture and confidence;
- age, coverage, and missingness of each Signal Family;
- baseline and policy revision;
- weighted contribution and reason codes;
- state-transition history;
- direct partner corrections and overrides;
- source consent and retention;
- Affect Advisory send, receive, decline, and failure state;
- environmental action eligibility and outcome;
- false-positive and usefulness feedback.

Garden must not expose raw private source content merely to make a graph look
complete.

Every decision should answer:

> Why did the posture change, which evidence was available, and which evidence
> was missing?

## 17. Evaluation

Run the estimator in shadow mode before it can affect interaction or the
environment.

Measure:

1. **Coverage** — how often enough independent, fresh evidence exists.
2. **False-positive burden** — unsupported posture changes and unwanted
   check-ins.
3. **Detection latency** — time from a partner-labeled meaningful shift to the
   first supported estimate.
4. **Correction rate** — how often partner feedback changes direction,
   weighting, or baseline.
5. **Posture usefulness** — whether the partner and companion judge the change
   in approach helpful.
6. **Intervention burden** — interruptions, notifications, and environmental
   actions per posture.
7. **Cluster handoff quality** — accepted, declined, stale, duplicate, and
   misrouted advisories.
8. **Dependence check** — whether the design supports healthy relationships
   and reduces unnecessary system engagement.

The evaluation must include negative controls and periods of ordinary schedule
change. Vacation, deadlines, illness, travel, and device loss can resemble an
affect shift.

## 18. Current PSFN Seams

The design extends existing primitives:

- [`SensorIngestPort`](../src/shared/telemetry/sensor-ingest-port.ts) and the
  typed event bus provide the ingress spine.
- [`sensor-cognition-bridge.ts`](../src/core/agent/perception/sensor-cognition-bridge.ts)
  already normalizes governed presence and identity claims.
- [`telemetry-validation.ts`](../src/core/emotion/telemetry-validation.ts)
  already models provenance, confidence, staleness, conflict, and suppression.
- [`participant-trends.ts`](../src/core/emotion/participant-trends.ts) already
  accumulates bounded per-participant conversational trends.
- [`emotional-baseline.ts`](../src/core/contacts/store/emotional-baseline.ts)
  holds narrow contact-local conversational mood summaries.
- [`memory-store-port.ts`](../src/faculties/memory/memory-store-port.ts) and
  [`social-graph-queries.ts`](../src/core/contacts/postgres-adapter/social-graph-queries.ts)
  provide current Partner Model ingredients. The unified Partner Assertion
  store, slow Partner Profile projection, and expiring Partner Current Context
  remain target work.
- [`icp-autonomy.ts`](../src/shared/contracts/icp-autonomy.ts) provides current
  same-cluster identity, availability, fatigue, provenance, and permit
  semantics.

Existing `EmotionState` describes the companion's own affect. It must not be
reused as the partner's composite state.

Existing participant trends and contact emotional baselines are narrow
conversation-derived signals. They are not the Partner Affect Estimate.

The current API telemetry allowlist accepts heartbeat, status, and incident
envelopes. Presence rides the status shape. General health and behavioral
summary contracts remain target work.

Current ICP has no typed Affect Advisory. Shared-satellite observation scopes,
emanation allowlists, and primary-first response leases are shipped seams; they
do not themselves grant Partner Affect signal access or define Affect Advisory.

## 19. Delivery Sequence

### Slice 1: Contracts and shadow observations

- tracked by `psfn-framework-qeid`;
- define Signal Observation and Partner Affect Estimate contracts;
- bind every observation to one partner and consent record;
- add source health, freshness, and missingness views;
- keep all outputs shadow-only.

### Slice 2: Deterministic estimator

- add personal baselines and source-family budgets;
- add JSON-owned weights, directions, windows, and thresholds;
- emit explainable estimates and `unknown`;
- validate against labeled history without changing behavior.

### Slice 3: Support Posture

- add hysteretic state transitions;
- expose Garden history and partner corrections;
- constrain interaction registers;
- keep environmental action disabled.

### Slice 4: Cluster advisory

- add the typed Affect Advisory;
- enforce exact sender, recipient, partner, consent, and capability scope;
- integrate ICP availability and fatigue;
- test duplicate, stale, unavailable, and denial paths.

### Slice 5: Bounded environmental support

- add Prospective Support Plan actions;
- route through the governed world-action boundary;
- add household policy and reversible overrides;
- validate in shadow before enabling actuation.

### Slice 6: Personal Operations Pack enrichment

- add each Pack signal family separately;
- require baseline calibration and source review;
- prove Pack disablement leaves core estimation operational;
- evaluate whether each source adds value before retaining it.

## 20. Non-Goals

Partner Affect Estimation does not:

- diagnose depression, anxiety, mania, or another condition;
- claim to read the partner's mind;
- replace direct conversation, human care, or professional care;
- infer imminent danger from a composite score;
- contact another person automatically;
- create Tasks or calendar events;
- give the estimator direct world-control authority;
- quote private consumption data as criticism;
- model every person in the partner's social graph;
- share raw observations through ICP;
- override companion fatigue or personal time;
- delay privacy revocation;
- optimize for engagement, dependence, or exclusivity;
- depend on the Personal Operations Pack.

## 21. Evidence Posture

Passive behavioral sensing is plausible but uneven. Published studies report
substantial variation between people and between signal types.

One study found weak population-level daily mood prediction and better results
for some personalized models:

<https://pmc.ncbi.nlm.nih.gov/articles/PMC8491547/>

Longitudinal studies also support idiographic models while documenting
replicability, adherence, and temporal-specificity limits:

- <https://www.nature.com/articles/s41746-024-01035-6>
- <https://www.nature.com/articles/s44184-023-00041-y>

Those findings support personal baselines, uncertainty, and shadow evaluation.
They do not justify diagnostic claims.

The FDA's general-wellness guidance distinguishes lifestyle support unrelated
to diagnosis or treatment:

<https://www.fda.gov/regulatory-information/search-fda-guidance-documents/general-wellness-policy-low-risk-devices>

Any future diagnostic, treatment, or clinical-risk claim requires a separate
legal, clinical, and product review. This design deliberately makes none.
