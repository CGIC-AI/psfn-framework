# Testing boundaries and audit decisions

Use real runtime journeys to prove that the product works across processes,
storage, authentication, and restart. Keep focused tests for contracts that a
small number of journeys cannot cover: authorization, tenant isolation, parser
rejection, concurrency, atomicity, and failure recovery.

## Choosing a check

| Command | Boundary and evidence |
| --- | --- |
| `npm run smoke:docker` | Disposable gateway, agent, operator, PostgreSQL, Hub, and Companion UI. Drives production entrypoints with an authenticated HTTP model double; checks delivered and persisted outcomes. |
| `npm run verify:companion-browser` | Built/development Companion UI in Chromium. Includes real service-worker lifecycle and controlled fleet/Hub protocol fixtures. These fixtures do not certify a deployed OAuth provider. |
| `npm run test:integration` | PostgreSQL and other integration contracts selected by `vitest.config.ts`. Tests with a real database preserve invalid-write, tenant, concurrency, and restart proof. |
| `npm run test:unit` | Focused source contracts. Passing this suite alone does not establish a working application. |
| `npm run test:shakedown-harness` | Harness regression checks, including subprocess ownership, stream verdicts, evidence collection, and browser-sweep failure handling. This does not run a live shakedown. |
| `npm run e2e` | Scripted in-process scenarios. Their testing-harness ingress intentionally disables production background side effects. Use Docker for production post-turn behavior. |
| `npm run gate:pre-pr` | Exact committed-head validation, including the applicable Docker, browser, harness, and specialist checks. GitHub verifies its attestation rather than repeating the heavy suites. |

The Docker stack chooses an isolated Compose project and loopback ports and
destroys its own volumes on exit. `--keep-up` retains that disposable stack for
diagnosis. Its provider double substitutes the external model HTTP boundary;
it does not replace the agent, tools, storage, or authorization. No provider
account or live deployment is needed. Model quality and real provider service
compatibility require separately configured evaluation.

## What changed in the October 2026 audit

The inventory at `78f52191d` contained 1,703 source test files, including 115
explicit integration files; the integration profile also named seven
PostgreSQL harness files. Separate suites covered Garden, Companion UI, Hub,
evals, CI policy, and shakedown. Counts describe inventory, not confidence.
The audit inspected suite selection and harness architecture across the stack,
then traced high-risk and suspicious tests to production owners and existing
behavioral coverage. It did not classify every assertion in every file.

| Finding | Decision and preserved proof |
| --- | --- |
| Scripted recall returned a known dessert without memory; workbench answers bypassed execution. | Remove canned success paths. Require retrieved evidence and real sandbox execution, with absent/unauthorized/deleted-memory controls. |
| Completion handoff tests searched source text for method names. | Execute the real shard/subagent composition and assert delivery to the captured session, no parent transcript pollution, and one replay. Removing either delivery arm makes its test fail. |
| Automata tests asserted SQL substrings. | Execute invalid writes and lease/FK/cascade contracts against PostgreSQL. Removing vector dimensionality enforcement makes the rejection test fail. |
| `wireGitRuntime` existed only for its test. | Remove the unused wrapper; retain actual Git registration and read-only tool contracts. |
| Scheduler and Garden tests required internal names or CSS classes. | Remove structure/style inventories. Retain callable scheduler settings, navigation, editor state, and independent security checks. |
| Browser and shakedown checks could be omitted by local gate routing. | Select the relevant suites explicitly. Runtime source and Docker journey changes select the real-process smoke stack under the heavy-suite lock. |
| Fleet browser fixture used a retired login URL; service-worker tests targeted a removed upload control. | Exercise the current login route, private draft clearing, and active UI state across service-worker updates. |
| Autonomy regression profile silently selected two of six named files after source moves. | Repair the paths and fail configuration if any exact profile entry is missing. All six now execute. |

Source-text checks that still protect a distinct security or client-wiring
boundary remain until executable replacement proof exists. For example,
biography client digest binding is not established merely by a passing server
route test. A mock count or `readFile` call alone is not a deletion criterion;
many tests legitimately inspect filesystem output or security boundaries.

The Docker extraction scenario also exposed a product edge case:
`extractionInterval=1` selects only the final assistant entry and can omit the
user fact even when the background job succeeds. The smoke uses a complete
two-entry pair. The interval-one source/coverage contract is tracked separately
as `psfn-framework-rws51`; a passing smoke does not certify that setting.

The main Companion UI conversation currently renders a final gateway result,
and its remembered transcript lives in a process-local browser map. The HTTP
streaming journey therefore does not establish incremental browser rendering,
and rereading a durable Garden turn after reload does not establish visible
transcript restoration. Those product capabilities are tracked as
`psfn-framework-mg891` and `psfn-framework-jtr6e`, respectively. Key-only fleet
authentication exercises one owner; it does not certify multiple OAuth accounts
or an external identity provider's session revocation.

## Evidence and failure diagnosis

Docker journeys connect public streaming output to its durable TurnRecord and
correlated request/turn events, then reread after process restart. Provider
failure and cancellation must terminalize, and the same session must accept a
subsequent request. A healthy endpoint or a nonempty answer is insufficient.

`PSFN_SMOKE_ARTIFACT_PATH` selects the evidence JSON; the default is under the
temporary directory for the unique Compose project. Portable evidence uses
explicit metadata fields and content hashes rather than raw prompts, replies,
tool arguments, or credentials. Browser failure traces and screenshots stay in
ignored, worktree-local `companion-ui/test-results/`; they may contain rendered
fixture content and should be inspected before sharing.

The runtime performance event stream is bounded, process-local telemetry. A
correlated test artifact is useful diagnostic proof, but it is not a durable,
complete distributed tracing backend or a complete graph of provider retries.
Persisted TurnRecords remain the source for durable turn outcomes. Tests should
fail on missing required correlation instead of interpreting absent telemetry
as success.

New journey cases should use generated case identities and verify observable
effects through the product boundary. Include a negative control that removes
the fact, authority, delivery, or effect the case claims to prove. Avoid adding
mock choreography or source inventories to raise the test count.
