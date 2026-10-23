# PSFN application security audit — 2026-10-22

## Executive summary

This source-level audit reviewed PSFN at baseline commit `e6a9546051f4`. It confirmed nine first-pass findings: **1 Critical, 4 High, 3 Medium, and 1 Low**. The most serious issue allowed an anonymous network caller to enter Satellite Hub and Voxta conversation paths, select or predict sessions, invoke paid providers, and receive model output. Other findings covered remotely triggerable process termination and resource exhaustion, deployable weak credentials, unsafe standalone Garden browser authentication, conversation-data leakage, regular-expression denial of service, and a DNS-rebinding race.

All nine source findings have remediations in the release-candidate branch. The remediation review also found and fixed additional denial-of-service and supply-chain weaknesses. Source status is therefore **remediated, pending merge and live private-environment validation**. It is not a claim that production has been deployed, rotated, penetration-tested, or certified.

| Item | Value |
| --- | --- |
| Audited baseline | `e6a9546051f4` |
| Validated implementation head | `e8c63d33aba92a3f08d0e306fa3b6f156a0a4ce6` |
| Primary findings | 1 Critical / 4 High / 3 Medium / 1 Low |
| Tracker epic | `psfn-framework-zbbxj` |
| Source certification | `psfn-framework-zbbxj.8` |
| Deferred live validation | `psfn-framework-9yibw` |

## Scope and method

The review covered application trust boundaries in the TypeScript services, Python Satellite Hub, .NET Voxta relay, Garden browser surface, Gateway transports and filesystem tools, Helm chart and lifecycle scripts, remote-media networking, logs, local artifacts, and locked third-party dependencies.

The audit used manual data-flow and authorization review, adversarial input analysis, configuration and secret tracing, dependency-vulnerability scans, and exploit-shaped unit, process, HTTP, WebSocket, filesystem, chart-render, and network-seam tests. It did not use production credentials or mutate a live deployment.

Severity reflects a combination of exploitability, required access, confidentiality/integrity/availability impact, and blast radius. “Remediated” below means the control and a regression test are present in the release candidate; it does not mean the corresponding change is already on `main` or deployed.

## Primary findings

| ID | Severity | Finding | Baseline evidence | Release-candidate disposition |
| --- | --- | --- | --- | --- |
| PSFN-SA-01 | Critical | Satellite Hub and Voxta accepted anonymous callers | `apps/satellite-hub/src/ts/hub/server.ts:458-480`; `apps/satellite-hub/src/ts/hub/voxta-facade.ts:115-156` | Remediated: fail-closed authority, dedicated credentials, principal-bound sessions, Origin policy, Voxta disabled by default, loopback-only development exception |
| PSFN-SA-02 | High | Malformed WebSocket JSON and percent-encoded Voxta paths could terminate the process | `apps/satellite-hub/src/ts/hub/server.ts:474-485`; `apps/satellite-hub/src/ts/hub/voxta-facade.ts:1390-1435` | Remediated: guarded parsing and stable request/socket-local rejection; forked-process recovery tests |
| PSFN-SA-03 | High | Hub messages, bodies, audio, queues, negotiations, connections, and provider responses lacked complete aggregate limits | `apps/satellite-hub/src/ts/hub/server.ts:98`; `apps/satellite-hub/src/ts/hub/voxta-facade.ts:115-126` | Remediated: streaming byte/time caps, bounded queues and populations, transport backpressure, idle/send deadlines, provider-response limits |
| PSFN-SA-04 | High | Helm and runtime admitted published, weak, or reused credentials | `deploy/helm/psfn/values.yaml:412-451`; `deploy/helm/psfn/values.yaml:485-498` | Remediated: production defaults fail closed, role-aware effective-key validation, placeholder/reuse rejection, safe existing-Secret lifecycle |
| PSFN-SA-05 | High | Standalone Garden could expose a raw long-lived administrator token over plaintext HTTP | `src/operator/garden/server-routes.ts:145-168`; `src/operator/garden/server-auth.ts:10-37`; `src/operator/garden/auth-policy.ts:16-38` | Remediated: non-loopback TLS/proxy requirement and short-lived opaque server-side sessions; raw token is never stored in a cookie |
| PSFN-SA-06 | Medium | Conversation content leaked to logs; content artifacts inherited ambient permissions and had no bounded retention | `apps/satellite-hub/src/ts/hub/server.ts:1256-1258,1425-1433`; `apps/satellite-hub/src/ts/hub/artifacts.ts:20-70` | Remediated: closed-schema content-free logging; contained no-follow artifacts; private modes/ACLs; atomic creation; bounded retention |
| PSFN-SA-07 | Medium | `fs.search` executed attacker-shaped JavaScript regular expressions synchronously | `src/boundary/integrations/filesystem/workspace-ops.ts:351-390` | Remediated: isolated killable workers, hard deadline, bounded transfer, cleanup, and literal-mode preservation |
| PSFN-SA-08 | Medium | Garden cookie-authenticated requests and WebSocket upgrades lacked complete Origin and CSRF binding | `src/operator/garden/server.ts:133-165,258-263`; `src/operator/garden/server-auth.ts:10-37` | Remediated: exact trusted HTTPS Origin/Host checks, CSRF proofs, strict secure cookies, rotation/logout revocation, browser security headers |
| PSFN-SA-09 | Low | Remote media validation resolved a hostname, then global `fetch` could resolve it again | `src/channels/backplane/safe-remote-fetch.ts:44-60,116-124` | Remediated: each hop connects to the policy-approved address while preserving hostname/SNI verification; redirect revalidation and cleanup retained |

## Detailed risk and remediation notes

### PSFN-SA-01 — anonymous Hub and Voxta authority

The baseline treated a realtime connection as authenticated whenever no device registry was configured, attached it to Satellite/companion processing immediately, and handed Voxta upgrades and HTTP routes to handlers without a caller identity. A network-reachable default could therefore expose conversation state and provider-backed actions without a server-verifiable principal.

The candidate centralizes Hub admission, requires enrolled-device or dedicated Voxta credentials outside an explicit loopback-only development mode, binds sessions to the authenticated principal, rejects untrusted browser origins, and makes Voxta opt-in. Negative tests exercise the main realtime socket, negotiation, raw SignalR WebSocket, service toggles, audio artifacts/input, vision routes, cross-principal session attachment, and valid credential paths.

### PSFN-SA-02 — parser-triggered process termination

The baseline parsed realtime JSON inside an event callback before the promise rejection chain and called `decodeURIComponent` in route parsers without converting `URIError` into a request-local failure. One malformed frame or path could escape the intended error boundary.

The candidate guards protocol and URL parsing, emits stable content-free errors, and closes only the offending request or socket. Child-process tests send malformed JSON, SignalR records, percent encodings, multipart data, and audio specifications and then prove a legitimate request still succeeds.

### PSFN-SA-03 — incomplete resource accounting

Several individually plausible operations had no aggregate budget: WebSocket payloads inherited permissive library defaults, HTTP bodies and uploads were fully buffered, audio sessions and negotiation tokens accumulated, provider responses could expand, and slow or abandoned producers could hold work indefinitely.

The candidate introduces shared transport budgets, bounded streaming reads, per-principal and global admission, queue and buffered-byte accounting, idle/operation deadlines, early rejection before provider or artifact side effects, and deterministic cleanup. Exact-limit, one-over-limit, concurrency, slow-client, abandonment, recovery, and no-side-effect tests cover both TypeScript and Python Hub paths.

### PSFN-SA-04 — deployable weak credentials

The checked-in chart set `secrets.allowMissingRequired: true` and supplied known `CHANGE_ME` values for multiple privileged roles. Runtime checks generally proved only that a value existed, not that it was strong, distinct, or actually the key consumed through an alias or database URL.

The candidate makes production rendering fail closed unless strong values or a valid existing Secret are supplied, validates the effective physical key behind role aliases and database overrides, rejects published placeholders and prohibited reuse, and keeps synthetic non-production fixtures separate. Lifecycle tests cover generated and preserved Secrets without printing their values.

### PSFN-SA-05 and PSFN-SA-08 — standalone Garden browser boundary

The baseline reused the raw long-lived `ADMIN_TOKEN` as a cookie, did not mark it `Secure`, allowed non-loopback plaintext operation when a token existed, and authenticated WebSocket upgrades without validating browser Origin. A stolen token had a long lifetime, and a hostile same-site origin could ride a browser cookie.

The candidate requires a trusted HTTPS origin for non-loopback standalone use, exchanges the administrator credential for a random bounded server-side session, uses strict secure cookie attributes, rotates and revokes sessions, requires CSRF proof for unsafe methods, validates WebSocket Origin before authentication, and emits defensive browser headers. The Helm chart enforces a single standalone session replica because the store is intentionally process-local.

### PSFN-SA-06 — privacy and artifact lifecycle

The baseline wrote transcript and reply text at ordinary log levels and persisted audio, transcript, reply, event, and vision data with inherited filesystem permissions. There was no uniform containment/no-follow policy or bounded default retention.

The candidate replaces open-ended logging with content-free structured fields and sentinel tests across stdout/stderr. TypeScript, Python, and .NET artifact stores use private directories/files, containment and link/reparse defenses, bounded downloads, atomic finalization, and a documented 24-hour default retention sweep. Native Windows ACL behavior still requires the live validation described below.

### PSFN-SA-07 — regular-expression denial of service

The baseline applied caller-provided ECMAScript regex directly in the Gateway event loop. Cooperative checks between matches could not interrupt catastrophic backtracking inside one `RegExp.exec` call; `^(a|aa)+$` against an 8,192-character near miss reproduced the stall.

The candidate runs regex work in isolated workers under a parent-enforced deadline and resource budget, terminates timed-out workers, and preserves literal search semantics. Tests prove event-loop responsiveness, repeated-attack cleanup, caller cancellation cleanup, content-free error output, and successful searches after abuse.

### PSFN-SA-09 — DNS validation/connect race

The baseline checked a resolver result for private or metadata addresses but then passed the hostname to global `fetch`, allowing connection-time DNS to return a different address.

The candidate pins connection establishment to an approved address for every hop while retaining the original hostname for HTTP Host, TLS SNI, and certificate validation. Controlled resolver/connector tests cover rebinding, mixed answers, address-family changes, redirects, failures, and socket cleanup.

## Additional findings discovered during remediation

These items are not retroactively included in the original nine-finding severity total.

| ID | Severity | Finding | Disposition |
| --- | --- | --- | --- |
| PSFN-AF-01 | High | Gateway RPC WebSocket/NDJSON frames and pre-identification connections lacked a repository-owned aggregate memory/socket bound | Remediated with a common 64 MiB UTF-8 frame ceiling, incremental NDJSON framing, compression disabled, two pending slots, topology-derived role slots capped at 64, five-second identification deadline, and terminal-path charge release (`psfn-framework-iwl12`) |
| PSFN-AF-02 | High | The Windows Voxta relay created one fire-and-forget microphone send task per callback; stalled upstream sends retained audio without a hard aggregate bound or coordinated shutdown | Remediated with synchronous bounded admission, one owned send pump, active-send byte/chunk accounting, fixed operation and shutdown deadlines, idempotent cleanup, and concurrency regressions (`psfn-framework-zbbxj.11`) |
| PSFN-AF-03 | Mixed: 3 Critical / 3 High / 10 Medium / 1 Low | The pinned Python graph contained 17 fixable OSV advisories across `anyio`, `certifi`, `cryptography`, `idna`, `pygments`, `pytest`, and `zeroconf`; the repository scanner omitted `uv.lock` | Remediated with stable upgrades, a clean direct pinned scan, and permanent `uv.lock` coverage (`psfn-framework-zbbxj.9`) |
| PSFN-AF-04 | High | The .NET relay resolved vulnerable `Microsoft.AspNetCore.SignalR.Common` 8.0.26 through an unlocked graph (GHSA-334f-vvp4-7g6p / CVE-2026-70159) | Remediated with exact SignalR 8.0.32, committed NuGet locks, locked restore, clean NuGet/OSV scans, and supported Windows publish validation (`psfn-framework-zbbxj.10`) |
| PSFN-AF-05 | High | Valid Gateway RPC requests could start unbounded concurrent handlers and accumulate unbounded native outbound buffers; disconnected cancellation-ignoring work could be replaced by reconnecting | Remediated with four request workers per connection, separate bounded control capacity, 16-frame/64 MiB connection admission, a global 256-frame/128 MiB retained-work budget, native-buffer-aware output limits, operation deadlines, and charges retained until actual settlement (`psfn-framework-zbbxj.12`) |
| PSFN-AF-06 | High | Python realtime sockets were counted only after the HTTP/WebSocket handshake, so incomplete handshakes bypassed `max_connections` | Remediated by charging accepted sockets before protocol allocation, rejecting excess sockets with a lightweight aborting protocol, and holding each charge through terminal TCP cleanup (`psfn-framework-zbbxj.13`) |
| PSFN-AF-07 | High | Voxta replies and several Hub HTTP, SSE, provider-WebSocket, generated-image, STT, and TTS response paths could retain upstream-controlled data beyond the configured budgets | Remediated with shared declared/chunked response readers, UTF-8 reply accounting, SSE idle/frame limits, provider frame/audio caps, bounded decoder output, response disposal, content-free errors, and exact/one-over/recovery tests (`psfn-framework-zbbxj.14`) |
| PSFN-AF-08 | High | The Helm physical-role registry omitted Voxta and other effective Secret consumers, allowing a Voxta reference to select an administrator or unrelated private key tuple | Remediated with an authoritative effective tuple inventory, dedicated chart-owned Voxta role, source-derived and rendered-manifest coverage, mutation testing, and reuse rejection without value disclosure (`psfn-framework-zbbxj.15`) |
| PSFN-AF-09 | High | Model and TTS execution bypassed the Hub-wide provider budget, so disconnecting and reconnecting could accumulate cancellation-ignoring provider work after socket admission was released | Remediated by charging model, streaming TTS, browser speech, Voxta, and Eidoverse execution through actual iterable settlement and cleanup; timeout and shutdown remain hard-bounded without prematurely releasing the provider charge (`psfn-framework-zbbxj.16`) |
| PSFN-AF-10 | High | Cancelled provider contexts could release logical state while outbound WebSocket sends remained in native or callback-pending buffers; 50 cancelled ElevenLabs turns retained more than 2 MiB despite a 1 KiB configured limit | Remediated with socket-owned byte/frame/callback admission, native-buffer accounting, bounded send completion, budgeted protocol pongs, terminal teardown, content-free errors, and fresh-connection recovery across ElevenLabs, Deepgram, MCPL, Home Assistant, and the companion browser relay (`psfn-framework-zbbxj.18`) |
| PSFN-AF-11 | Medium | The loopback Voxta relay accepted a hostile HTTP `Host` when `Origin` was absent, then attached its stored upstream bearer credential, leaving a DNS-rebinding path to authenticated upstream GET routes | Remediated with exact configured literal-loopback IP and port authority binding, absolute-form rejection, independent Origin checks, and IPv4/IPv6 process tests proving hostile authorities have no upstream, session, microphone, or artifact effects (`psfn-framework-zbbxj.17`) |
| PSFN-AF-12 | High | Main realtime and Voxta listener WebSockets left automatic pong enabled, allowing control replies to bypass application output budgets; an unauthenticated pre-hello peer retained about 8.4 MiB despite a 1 KiB configured limit | Remediated by disabling automatic pong on realtime, SignalR, and audio listeners and sharing socket-owned data/pong/close admission, native frame-header projection, callback/frame limits, bounded completion, terminal-only connection release, and real unread-peer recovery tests (`psfn-framework-zbbxj.19`) |
| PSFN-AF-13 | Low (assurance) | Privacy-safe fatal-error redaction made two positive executable HMAC-rotation tests fail before they could prove that valid fresh and retained keyrings passed runtime credential validation | Remediated with a fixed content-free post-validation stage marker, executable positive and negative ordering assertions, mutation proof, persisted-diagnostic checks, and continued fatal-detail redaction (`psfn-framework-zbbxj.20`) |
| PSFN-AF-14 | High | Python realtime automatic pongs bypassed the configured 1 MiB `write_limit`; a real authenticated non-reading peer retained 2,219,448 native bytes while the protocol remained open | Remediated with one socket-owned application/control frame budget below serialization, native-buffer accounting, absolute completion deadline, failed-output fencing at parser, receive, and supported-Python-3.11 dispatch handoff seams, terminal-only admission release, repeated-cancellation-safe shutdown ownership, and real unread-peer recovery tests (`psfn-framework-zbbxj.21`) |
| PSFN-AF-15 | Medium | Python outbound Deepgram and ElevenLabs WebSockets used default automatic control output, allowing a malicious configured provider to retain more than 1.3 MiB and 1.5 MiB respectively while clients stayed open despite 1 KiB inbound limits | Remediated with a shared provider client output owner covering data/control/fragment writes, pending handshakes, direct CPython TLS BIO plus raw TCP accounting, conservative TLS expansion, deadlines, concurrent context cleanup, and fresh-stream recovery; unaccountable nested TLS fails closed (`psfn-framework-zbbxj.22`) |
| PSFN-AF-16 | Medium | Repeated Python Hub CLI shutdown cancellation could make the runtime terminal while artifact cleanup, listener threads, sockets, provider closes, watchdogs, responses, and device callbacks remained owned; a same-port restart failed with `EADDRINUSE` | Remediated with a retained shielded shutdown task, mandatory `AsyncExitStack` teardown, cleanup-failure sequencing, active-turn/provider settlement, synchronous callback admission closure, joined callback/watchdog/response tasks, and real listener same-port restart tests (`psfn-framework-zbbxj.23`) |

Independent reviews of successive assembled candidates found AF-05 through AF-16; each finding was reproduced, assigned a blocking bead, remediated, and independently retested before this report was updated. The remediation review also closed credential-role alias and database-override bypasses, synchronized credential policy copies, refreshed stale security fixtures, and separated encoded transport limits from decoded media limits. These are defense-in-depth corrections within the primary findings rather than separately counted vulnerabilities.

## Validation evidence

The root validator reproduced implementation-agent claims on the assembled branch at `e8c63d33aba92a3f08d0e306fa3b6f156a0a4ce6`. Because the pre-PR gate and independent exact-head reviews must run after this report itself is committed, their final commit/result attestations are recorded on `psfn-framework-zbbxj.8` and the pull request rather than self-referentially embedded here.

| Control | Evidence |
| --- | --- |
| Hub authentication, parser survival, resources, privacy | `npm run verify:satellite-hub`: 455 TypeScript tests and 221 Python tests; build/type checks passed. The final additions cover pre-handshake admission, provider-work lifetime, TypeScript and Python provider/listener socket output ownership, data/control/close frames, direct TLS/raw TCP accounting, failed-output dispatch fencing, cancellation-safe CLI/listener/provider/callback teardown, and bounded HTTP, mTLS, SSE, provider-WebSocket, reply, STT, TTS, and generated-image paths |
| Python provider output and CLI lifecycle | Provider output: 89 focused cases, with Deepgram and ElevenLabs final native plus pending retention at 921,287 and 921,418 bytes under the 1,048,576-byte cap; independent reviewers passed 12 direct-TLS cases. CLI lifecycle: 23 tests passed on supported Python 3.11.15 on the assembled branch, including repeated cancellation, cleanup/provider/listener failures, active turns, callbacks, and same-port restart |
| Credential startup proof | 45 executable credential-startup tests plus 19 logger/diagnostic privacy tests passed on the assembled branch. Mutation testing proved weak, malformed, and reused HMAC configurations fail if the acceptance marker is emitted before validation; valid fresh and retained rotations reach the fixed marker without exposing credentials, paths, or fatal detail |
| Gateway framing, admission, and RPC flow control | 75 exact Unix/mTLS-WebSocket transport and flow-control regressions passed on the assembled head; the implementation lane passed 460 tests across 22 files plus type, lint, build, privacy, and applicable structural checks |
| Filesystem regex isolation | 153 independently selected unit/integration tests passed, including hostile near-miss, cancellation, cleanup, and recovery |
| Garden browser security | 82 focused browser-session tests and 118 Garden/chart tests passed |
| Helm credentials and lifecycle | 1,439 selected Helm/lifecycle/chart tests passed; the final physical-role inventory matrix passed 64 tests, the root validator reproduced 1,345 focused tests, and all 124 chart checks passed; recovery chart digest verified over 34 files |
| DNS pinning and media limits | 277 focused remote-fetch and channel transport tests passed |
| Python dependencies | Frozen Python 3.11 sync, 221 Python tests on the assembled head, wheel/sdist build, and pinned OSV scan passed with 36 packages and zero findings |
| .NET relay | Two locked restores, two builds with zero warnings/errors, two format checks, logger/artifact/microphone/build-contract harness, 92 authority cases, seven IPv4/IPv6 actual-process auth/Host/privacy tests, two online transitive NuGet scans, and locked self-contained `win-x64` single-file publish passed |
| Repository dependency scan | Digest-pinned OSV-Scanner 2.4.0 scanned eight committed lockfiles and 1,366 resolved package records with zero known findings and no suppressions |
| Final repository gate | Run once on the final committed pull-request head; exact result and SHA are recorded on `psfn-framework-zbbxj.8` and the pull request |
| Independent exact-head review | Standards, specification, adversarial, and scanner results are recorded on `psfn-framework-zbbxj.8` and the pull request after this report commit |

## Residual risk and required live validation

The source candidate cannot prove properties owned by a private deployment. Bead `psfn-framework-9yibw` remains open for an explicitly authorized non-production cluster and Windows relay host. It requires:

- exact image and chart digest deployment with rollback evidence;
- preservation and rotation of real Kubernetes Secrets;
- real TLS ingress identity and authenticated Hub, Voxta, and Garden clients;
- anonymous, hostile-Origin, CSRF, cross-principal, oversized, malformed, slow-client, abandoned-stream, provider-amplification, regex, and DNS-flip probes;
- bounded RSS, threads, descriptors, sockets, queues, and retention under sustained native load; and
- Windows NTFS execution of the relay artifact harness to prove protected owner-only ACLs, reparse-point and hard-link rejection, atomic finalization, cleanup, and content-free errors.

Until that evidence exists, operators should treat the candidate as source-remediated but not production-certified. Deployment must use fresh role-distinct credentials; published examples or values from the audited baseline must never be reused.

## Tracking and closure policy

The implementation beads remain open or in progress until their commits land on `main`. Completion evidence is recorded on each bead, and the integrated certification bead is the dependency for the final pull request. This prevents a pushed branch or passing agent-local test from being misrepresented as shipped remediation.
