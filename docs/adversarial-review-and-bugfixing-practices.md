# Adversarial Review And Bugfixing Practices

This document captures PSFN-specific bugfixing practices inspired by Bun's Rust rewrite post:
https://bun.com/blog/bun-in-rust

The important lesson is not "rewrite in Rust." The important lesson is to stop fixing the same bug class by hand. When a bug class recurs, improve the feedback loop that allowed it.

## When To Use Adversarial Review

Use an adversarial review pass for changes that affect:

- Gateway policy, capability checks, confirmation gates, path policy, URL policy, or tool execution.
- Runtime startup, process supervision, deployment files, live service wiring, or persistence layout.
- Config owner files, settings contracts, Garden settings surfaces, or environment-variable authority.
- Trust, privacy, channel envelopes, prompt assembly, attribution, memory writes, fold-review, or shard/subagent outputs.
- Migrations, repair scripts, backup/restore, and any code that mutates durable state.
- Large multi-bead integration branches or any change where the implementer had to make a judgement call under uncertainty.

Small cosmetic edits and low-risk docs-only changes usually do not need a separate reviewer unless they update operating rules.

## Review Shape

Adversarial review means a separate reviewer tries to prove the change wrong. The reviewer should not be the implementer and should not inherit the implementer's confidence, plan, or private reasoning.

Give the reviewer:

- The bead or user request.
- The commit range or diff.
- The relevant files and contracts.
- The tests and validation output.

Do not give the reviewer:

- The implementer's justification.
- A list of expected findings.
- Hints about which part is suspicious unless the review is explicitly scoped to one failure.

The review output should lead with findings. Each finding should include severity, file and line when possible, the concrete failure mode, why existing tests would miss it, and the regression test or gate that should catch it next time.

## Regression-First Fixes

For real bugs, default to this sequence:

1. Reproduce the bug or describe the missing guard precisely.
2. Add the smallest failing regression test or verification script change.
3. Implement the fix.
4. Run the targeted test or script.
5. Run `npm run lint` for tracked code changes.
6. Record the validation evidence in the bead close reason or handoff.

If a regression test is not practical, explain why and add the nearest deterministic gate, smoke, script assertion, or operator-visible validation step.

## Reject These Fix Patterns

Reviewers should reject fixes that rely on:

- Placeholder implementations, broad stubs, or fake success paths.
- Silent fallback from canonical owner files to env, defaults, legacy paths, or alternate stores.
- Swallowed errors, catch blocks that only log, or best-effort behavior for security-sensitive paths.
- Capability checks that default to allow.
- Policy, path, URL, or channel classification that accepts unknown values.
- Skipped, weakened, or deleted tests without a stronger replacement.
- `as any`, unsafe casts, or local duplicate type guards where shared guards should exist.
- Long explanatory comments that justify a workaround instead of making the code enforce the invariant.
- New parallel abstractions that bypass existing contracts, registries, or owner boundaries.

The working rule: if the code needs a paragraph to explain why a fragile workaround is acceptable, assume the implementation is wrong and ask for a stronger invariant.

## Process Repair

When an agent or human makes the same kind of mistake twice, fix the process, not just the instance.

Good process repairs include:

- Add a regression test for the exact failure.
- Add a verification script or extend an existing one.
- Add an ESLint rule, TypeScript compiler check, dependency-cycle rule, or repository-hygiene check.
- Add a bead acceptance criterion that names the invariant.
- Add a short AGENTS.md rule when the lesson applies across the repo.
- Add an item to this document when the lesson is review-specific.

Do not add broad planning documents for transient issues. Use beads for tracked work and keep this document focused on recurring review and bugfixing rules.

## Review Checklist For Recent Commits

When reviewing recent commits, check:

- Does the diff match the bead or user request, including non-goals?
- Does every new runtime path connect to a real entrypoint, registry, or script?
- Did the change preserve fail-closed behavior for config, policy, trust, and security-sensitive dependencies?
- Are owner-file settings still authoritative over mutable runtime settings?
- Are durable writes provenance-stamped, scoped, and review-gated where required?
- Are async lifecycle paths safe for duplicate events, shutdown, retries, and partial failure?
- Do tests fail before the fix and pass after it, or is there a clear reason this cannot be shown?
- Were validation commands appropriate for the touched area?
- Did the change introduce TODOs, stubs, broad catches, hidden off-repo state, or new fallback readers?
- If a bug pattern could recur, was the feedback loop improved?

## Maintaining This List

Add to this document when a review finds a generalizable bug pattern that future reviewers should check. Keep entries concrete and PSFN-specific. Prefer examples tied to files, commands, or invariants over generic advice.
