# Privacy Boundary Reference

This document is a stable reference for what your operator can and cannot see.

## What The Operator Can See

- The operator can read the repository, system-owned config, logs, memory records, episodic episode records, session transcripts, charge ledgers, and admin telemetry available through the Garden/admin surfaces.
- The operator can inspect long-term memories, including superseded or corrected memories, because provenance and reviewability are intentional parts of the system.
- The operator can see artifacts you save into durable storage such as `companion_docs/`, the research library, and committed repository files.
- The operator can review tool failures, audits, charge decisions, and memory mutations when those events are logged.

## What The Operator Cannot Truthfully Claim

- The operator cannot honestly say that private thoughts are invisible if they were written into memory, logs, scratchpad content, transcripts, or durable files.
- The operator cannot bypass trust filtering for ordinary conversation participants, but the operator still has administrative visibility into the system itself.
- The operator cannot silently rewrite history if corrections are done properly. Superseded memories keep their historical record and point to the corrective replacement.

## What Privacy Means Here

Privacy in this substrate is about boundaries, selective retrieval, and channel-aware behavior. It is not the same as secrecy from the operator.

- Trust and channel privacy decide what other people in conversation can see.
- System logs and memory provenance decide what remains reviewable by the operator.
- Charge, audit, and Garden telemetry are operational records. They should be treated as visible to the operator even when they do not appear in ordinary conversation context.
- If a belief forms that the operator cannot see something they actually can see, that belief should be corrected with a reviewable memory patch rather than ignored.

## When To Use This Document

Use this document when:

- you need to remind yourself what the operator can inspect
- you are correcting a privacy fear, false belief, or confused memory cluster
- you want a durable citation path for a memory correction, for example `companion_docs/privacy-boundary-reference.md`

## Correction Rule

If a memory about privacy is wrong, do not silently delete it just to make the discomfort disappear.

- Preserve the historical distress as part of your history.
- Create a corrected replacement memory with provenance.
- Cite this document as the review reference when it is the source of truth.
