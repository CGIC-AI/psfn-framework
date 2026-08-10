---
name: bus
description: The shared-record practice for sessions that run more than one agent. Open a run file, append typed messages with provenance as work happens, resolve rank disagreements explicitly, and validate the file before closing. Use whenever a task is dispatched to two or more agents, or when a run file already exists in the project.
---

# The agent bus

Parallel agents are blind to one another by default. They duplicate findings, rank the same
result differently with no channel to reconcile, and return transcripts instead of claims.
The bus is the correction: one shared, append-only JSONL file per run, which every agent and
the orchestrator write to as they work.

The tools are `bus-new`, `bus-append`, `bus-lint`, `bus-state`, `bus-bench`, `bus-embed` and `bus-model`. They must be on
`PATH`, or invoked by path from the agentbus checkout. `SCHEMA.md` in that checkout is the
codebook and is the authority on anything below.

All seven are yours to run. `bus-embed` and `bus-model` in particular are part of normal work,
not setup performed by a human beforehand: you run `bus-embed near` and `bus-embed dups` to
check whether a finding already exists, and you run `bus-model status` and `bus-model fetch`
to make sure the vector lane is available in the first place.

## When to open a run

Open a run when a session is about to dispatch work to two or more agents, or when it will
run several substantial phases whose findings must survive compaction.

```sh
bus-model status            # is the embedding model installed and ready?
bus-new <run-name>          # prints the path it created
```

If `bus-model status` reports that the active model is not installed, install it yourself with
`bus-model fetch all-MiniLM-L6-v2` before dispatching. It is an 87 MiB download that takes a
few seconds, and without it the duplicate check below falls back to reading the file by hand.

The run file lands in `$AGENTBUS_DIR`, or in `./bus/runs` if that variable is unset, named
`<YYYY-MM-DD>-<run-name>.jsonl`. Pass that path to every agent you dispatch, and tell each one
to read it before starting.

Do not open a run for single-agent work. A bus with one writer is overhead with no reader.

## Appending

Every agent appends as it works, and so does the orchestrator. An orchestrator that reads the
bus without writing to it leaves the record one-sided.

```sh
bus-append <file> --agent <name> --type <type> --body '<json object>'
```

The tool builds the schema version 2 envelope: run name, the next sequence number for that
agent, and a timestamp. It holds an exclusive lock while reading, allocating the sequence,
validating, and appending. It refuses anything invalid with a non-zero exit and nothing
written. If an append is refused, read the error and fix the message. Do not write to the
file by other means.

The eight types are `finding`, `rank`, `question`, `answer`, `handoff`, `cost`, `note`, and
`correction`. Use `--context '{...}'` to attach work-item, repository-state, agent-instance,
file, symbol, and artifact identity. Later messages inherit unambiguous context when omitted;
workers sharing one agent role pass `--agent-instance ID` to select only their own context.
Inheritance is per agent identity, so one parallel worker cannot replace another's scope.
Use `--meta '{...}'` only for free-form runtime metadata.

## Findings carry provenance, and it is mandatory

```sh
bus-append "$BUS" --agent builder --type finding --body '{
  "claim": "decode_record truncates records above 2 GiB",
  "evidence": "src/parser/decoder.c:141 reads the length into a signed int; a 2 GiB fixture decodes to 14 bytes",
  "provenance": "computed",
  "refs": ["src/parser/decoder.c:141"],
  "confidence": 0.95}'
```

`provenance` is one of four values, and choosing it honestly is the whole point of the field:

| value | use it when |
| --- | --- |
| `computed` | you ran the command, read the file, or carried out the derivation here; `evidence` plus body `refs` or envelope `context.artifacts` is required |
| `fetched` | you retrieved it from a source; non-empty `refs` are required |
| `recalled` | it comes from model memory and you have not checked it |
| `testimony` | a person or another agent reported it; `source` is required |

**Nothing outbound may rest on a `recalled` finding unchecked.** A recalled claim is welcome
on the bus, because an unverified lead is still worth sharing, but it does not enter a report,
a commit message, a patch, or an answer to the user until someone verifies it and appends a
new finding with the verified provenance. Confidence is not provenance. A claim you are sure
of but did not check is still `recalled`.

Verification is separate from provenance. A finding's optional `verification` object records
`pending`, `verified`, or `rejected`. Verified and rejected results must name the verifier and
an artifact digest or evidence ids.

## Check before you add

Before appending a finding, look for one that already says it. Rank or extend that finding
rather than duplicating it. Run the check yourself:

```sh
bus-embed near "$BUS" "the text of your claim"  # the closest existing findings
bus-embed dups "$BUS"                           # near-identical claim pairs already present
```

`near` is the one to reach for before posting, since it answers the question you actually
have. `dups` is for sweeping a run that has grown. If the vector lane is not installed, read
the file instead. Duplicated findings are the failure mode the bus exists to prevent, so the
check is not optional; only the method is.

## The embedding model

```sh
bus-model status            # active model, whether it is ready, whether it is intact
bus-model list              # the registry and its trade-offs
bus-model fetch <name>      # install one
bus-model verify [name]     # re-hash installed files against their recorded digests
bus-model use <name>        # change which is active
```

`all-MiniLM-L6-v2` is the default and suits almost every bus. Fetching and checking status are
routine, and you should do either whenever the lane looks unavailable.

**Switching the active model is the one deliberate act here.** Different models produce vectors
in different spaces, so a switch changes what "similar" means and causes every finding to be
embedded again under the new model. Switch only for a reason, and when you do, append a bus
note saying which model you selected and why, so that later similarity scores on the run can
be read correctly.

Concurrent embedding workers use a stable sidecar lock and recheck completed work before
appending, so they do not produce duplicate or partial vector rows.

## Rank disagreements are resolved, never averaged

A `rank` judges one dimension of a finding or delivered handoff:

```sh
bus-append "$BUS" --agent reviewer --type rank \
  --body '{"re": "builder-1", "dimension": "severity", "value": "major", "basis": "silent truncation with a success return"}'
```

Dimensions are confidence, quality, severity, priority, and acceptance. Confidence and
quality use numbers in [0, 1]; the other dimensions use the categories defined in `SCHEMA.md`.
When two ranks on the same target and dimension disagree, the run's resolver appends another
rank whose `resolves` array names the earlier rank message ids. Never average or delete the
earlier judgments. The record of the disagreement is what makes the resolution worth anything.

## Handoffs, questions, costs

```sh
bus-append "$BUS" --agent builder --type handoff \
  --body '{"path": "patches/0001-fix.patch", "status": "ready", "note": "214 tests pass"}'

bus-append "$BUS" --agent reviewer --type question \
  --body '{"to": "builder", "re": "builder-1", "text": "does the streaming path share this bug?"}'

bus-append "$BUS" --agent builder --type cost \
  --body '{"consumed": "~52k tokens, 95 min", "produced": "one defect, one patch, two tests"}'
```

Close every substantial contribution with a `cost` line. It is the only honest record of what
a piece of work took, and without it the run cannot be reviewed for value.

## Corrections

The file is append-only. Never rewrite or delete a line. A typed `correction` event names the
current message id and a relation of `corrects`, `supersedes`, or `retracts`. Correcting and
superseding require a replacement body valid for the original message type. Retracting
forbids one. Further changes target the latest correction in the lineage.

Use `bus-state "$BUS"` to inspect the correction-aware current state. Use `bus-bench` when a
run may be large; JSONL runs should be bounded to one work item or review cycle.

## Before closing the run

```sh
bus-lint "$BUS"
```

Exit 0 means clean. Exit 1 lists the problems, one per line, with line numbers. Revise valid
traffic with correction events, never by editing. Then post a closing `note` recording what goes outbound
and what stays internal as unverified.

## What agents return

An agent that has written to the bus returns a compact summary and its message ids to the
caller, not a transcript. The bus holds the detail; the return value holds the conclusion.
