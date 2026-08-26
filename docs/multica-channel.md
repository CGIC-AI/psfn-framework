# Multica gateway channel

Multica is a native, gateway-owned companion channel. It lets a Multica agent
assignment invoke one configured PSFN companion through the same canonical turn
pipeline used by the other request/response channels.

The authority split is deliberate:

- Multica owns projects, issues, squads, assignments, and the operator view.
- PSFN owns companion identity and cognition.
- Agentbus remains the intra-run evidence ledger; it is not the orchestration
  control plane.
- Satellite Hub is not part of this route. It continues to own endpoint
  transports such as Wyoming/OpenHome.

## Runtime flow

1. The PSFN gateway registers one Multica daemon runtime with provider `psfn`.
2. It heartbeats that runtime and serially claims assigned work.
3. For issue work, it uses the task-scoped credential only to fetch the current
   issue context. That credential is never inserted into model-visible content.
4. It emits a deterministic `channelType: "multica"` message and routes the turn
   to the companion pinned by `companionId`.
5. It completes the Multica task with the companion response, or reports the
   turn failure to Multica.
6. Gateway shutdown aborts polling and deregisters the runtime.

## Configuration

The system-owned `channels.json` file holds routing and a credential reference;
the bearer token itself remains in the gateway environment.

```json
{
  "multica": {
    "enabled": true,
    "baseUrl": "http://127.0.0.1:8080",
    "workspaceId": "<multica-workspace-uuid>",
    "companionId": "<psfn-companion-uuid>",
    "tokenRef": {
      "kind": "env",
      "envName": "MULTICA_GATEWAY_TOKEN"
    },
    "pollIntervalMs": 1000,
    "runtimeName": "V Unit 00"
  }
}
```

`baseUrl` must be an HTTP(S) origin without credentials, a path, query, or
fragment. `pollIntervalMs` must be between 250 and 60000. Enabled configuration
requires all routing fields and a structurally valid environment reference.
Gateway startup then fails closed if the referenced token is absent.

Use a Multica personal access token belonging to an operator with access to the
configured workspace. Do not put the token in `channels.json`, checked-in files,
logs, or task content.

The initial channel contract carries assigned work into the companion and its
result back into Multica. Companion-initiated squad/project administration is a
separate tool-authority layer built on top of this channel; it should use
task-scoped or explicitly delegated Multica capabilities rather than exposing
the gateway owner token to the companion.
