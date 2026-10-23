# TypeScript Hub privacy and retention

Hub and Pi runtime logs are structured operational events. The shared logger
accepts registered static event names, numeric sizes/timings/counters, fixed
outcomes, and hashed correlation identifiers. It drops transcript/reply text,
attachment names, URLs, credentials, arbitrary error messages/stacks/bodies, and
unknown fields before console or custom observers receive a record. There is no
content-bearing diagnostic logging switch; increasing log verbosity does not
enable conversation logging. Client frames, provider requests, and active session
history still carry the content required to serve an accepted turn.

Audio, transcript, reply, event, and vision artifacts are sensitive. All Hub
writers use the same Linux descriptor-pinned filesystem boundary: dedicated
roots and owned descendants are 0700; files are 0600 regardless of umask; full
writes use an exclusive temporary file, fsync, and atomic rename. PCM and event
appends use no-follow, regular-file descriptors with a single hard link. Root,
intermediate, and final symlinks and aliased hardlink destinations are rejected.
Use a dedicated local artifact directory, not a home or workspace root. These
controls do not protect against root or an attacker already controlling the Hub's
UID; that principal can read the process memory as well as private artifacts.

`RealtimeHubServer` starts expiry when constructed and stops its timer on close,
including the normal executable's failed-start cleanup. The default retention is
24 hours, checked at startup and every 60 seconds. Existing owned file/directory
modes are repaired during cleanup. Expiry is limited to known artifact partitions
(`YYYYMMDD`, `voxta-audio`, `voxta-vision`, and `eidoverse-vision`) and known legacy
audio/event filenames; symlinks and hardlinks are not followed. Unrelated files
are not a supported place to store private artifacts and are not cleaned.

An optional `HUB_ARTIFACT_POLICY_PATH` points to a JSON owner file:

```json
{ "schemaVersion": 1, "retentionHours": 24 }
```

Only those fields are accepted; retention must be an integer from 1 through 168
hours. Invalid policy fails startup. Policy changes require restart. Retention is
an age bound, not an encrypted backup or a disk quota; use a dedicated filesystem
with an operator-managed quota. Expiry permanently deletes expired artifacts.

## Completed-utterance STT

The TypeScript realtime and Voxta audio paths admit complete accepted PCM
utterances before spending on STT or creating turn artifacts. They intentionally
emit only final transcripts, not interim provider transcripts. During pending STT
or reply playback, incoming valid PCM is dropped rather than queued or appended;
the client can keep sending its normal ambient 20 ms frames. `interrupt` aborts
the per-turn STT signal immediately, acknowledges cancellation, and suppresses
cancelled transcript/reply artifacts. A subsequent utterance can recover.

`HUB_RESOURCE_LIMITS_PATH` also accepts `maxProviderOperations` (default 8) and
`providerTimeoutMs` (default 30000). The deadline aborts the provider signal and
returns promptly. An operation that ignores cancellation remains charged against
the independent provider quota until its actual promise settles; timing out does
not authorize a replacement. Normal Voxta audio close retains its admission until
accepted STT finalization settles. Shutdown aborts all provider signals and waits
at most `authenticationTimeoutMs` (default 5000); a noncooperative operation makes
shutdown fail within that bound instead of waiting forever. A supervisor can then
terminate the process. Rejected, malformed, overflowing, or aborted input does
not invoke STT or create a partial utterance artifact.
