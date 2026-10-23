# Filesystem search execution contract

`fs` with `action: "search"` and gateway RPC `fs.search` support literal
search (the default) and native JavaScript regular expressions (`mode: "regex"`).
Both modes trim the query, scan files in sorted path order, and report one-based
line and UTF-16 column positions. Matching is case-sensitive and global within
each line; regex flags are fixed to `g`. Flags such as `i`, `m`, `s`, and `u`
cannot be supplied. JavaScript lookbehind and backreferences remain supported.
Zero-length matches advance by one UTF-16 unit, including a match at line end.

The existing bounds apply to both modes: matching sees the first 8,192 UTF-16
units of each line; previews include the requested zero to two context lines
and truncate after 500 characters with `\n... (truncated)`. File reads default
to 40,000 bytes and cap at 200,000 bytes. Match and file limits remain 50/200
by default, capped at 200/500 respectively. `truncatedFiles` identifies byte
truncation, while `hitLimit` identifies match or candidate-list limits. Binary
pages containing a NUL byte are skipped.

Regex compilation and matching run in a dedicated worker for each search.
The parent enforces a two-second deadline covering compilation and scanning,
terminates the worker on timeout, and waits for its exit before settling the
search. No agent-supplied regex executes on the gateway event loop. The
existing 1,000-character pattern cap and nested-unbounded-quantifier rejection
remain early validation aids; the worker deadline also covers accepted patterns
that this lint cannot identify.

At most four regex workers run per process, with no waiting queue. Each worker
has 16 MiB old/young-generation limits and a 4 MiB stack limit. Only one bounded
file page is in flight per worker, and replies contain at most the remaining
match limit. Node's heap limits do not cover every native allocation; fixed
pattern/input bounds and the process-wide concurrency cap also constrain cost.
Workers are joined after success, failure, timeout, cancellation, disconnect,
and gateway shutdown. Shutdown refuses new connections before joining searches.

The tool's caller signal reaches local search directly. Gateway clients send
an opaque UUID with cancellable searches and forward aborts to `fs.cancel`;
only the same authenticated connection can cancel that ID. A cancel response
acknowledges the request; the original search settles after cleanup. Connection
shutdown cancels searches even when their callers did not provide IDs.

Errors never echo file content, patterns, worker diagnostics, or abort reasons:

| Condition | Message |
| --- | --- |
| Invalid or unsupported regex syntax | `fs search regex is invalid` |
| Deadline | `fs search budget exceeded: pattern took too long to evaluate and was aborted` |
| Admission limit, worker failure, or worker resource exhaustion | `fs search regex resources unavailable` |
| Caller abort, disconnect, or shutdown | `fs search aborted` |

Early pattern-length and nested-repetition errors retain their fixed
`fs search regex rejected:` explanations. No partial search results are returned
on any of these failures. A later search can use the released worker slot.
