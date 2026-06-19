# PSFN Satellite Mobile Chat App

`companion-ui` is a standalone mobile-first PWA for companion chat. It is a
client of the PSFN Satellite Hub and renders the relational chat surface plus
presence and operational state.

It does not run PSFN server logic, does not own memory or identity, and does
not talk to PSFN core directly.

## Boundaries

- All realtime traffic goes through the PSFN Satellite Hub websocket protocol.
- Do not call PSFN core endpoints from this app.
- Do not call `/api/admin/*` from this app.
- Do not add server logic to this package.
- Do not edit `../PSFN-Satellite-Hub/`; it is a read-only protocol reference.
- Keep this package standalone. Do not wire root auto-installs for it.

The hub protocol source of truth is:

```text
../PSFN-Satellite-Hub/src/ts/shared/protocol.ts
```

The local client mirror lives in:

```text
src/lib/protocol/events.ts
src/lib/protocol/framing.ts
```

If the local mirror and the hub protocol drift, the hub wins. Re-mirror the
client types from the hub instead of inventing new message shapes.

## Runtime Configuration

The app requires one Vite environment variable:

```bash
VITE_PSFN_SATELLITE_MOBILE_CHAT_APP_WS_URL=ws://hub.local:8787/
```

Use `ws://` or `wss://`. The client rejects empty values and rejects admin API
paths.

The default satellite identity sent in `hello` is:

```text
deviceId: psfn-satellite-mobile-chat-app
deviceName: PSFN Satellite Mobile Chat App
```

Default capabilities are text input, text/subtitle output, interrupt, presence,
session attach, confirmation-required safety, and local-only safety.

## Development

Install dependencies from this package directory:

```bash
cd companion-ui
npm install
```

Run the development server:

```bash
npm run dev
```

Build the PWA:

```bash
npm run build
```

Preview the production build:

```bash
npm run preview
```

Build output goes to `dist/`. The PWA manifest and service worker are in
`public/`.

## Validation

Use these checks for this package:

```bash
npm run test
npm run typecheck
npm run lint
npm run build
npm audit --omit=dev
```

For tracked repo work, the parent repository requires `npm run lint` before
closing the bead. Run that from the repo root:

```bash
cd ..
npm run lint
```

## Wire Protocol

Client to hub messages currently used by this UI include:

- `hello`
- `user.text`
- `turn.start`
- `turn.end`
- `interrupt`
- `ping`

Hub to client messages consumed by the UI include:

- `session.ready`
- `hello.ack`
- `message`
- `status`
- `error-event`
- `pong`

Unknown hub message types fail closed during framing.

## Current UI Surfaces

- Connection setup for hub websocket URL, session, and optional channel.
- Streaming chat transcript with live assistant draft handling.
- Presence strip for connection, phase, operation class, elapsed time, input
  expectation, satellite identity, status, and event count.
- Redacted activity drawer over hub events. It records metadata and redacts raw
  transcript content.
- Approval panel that fails closed until the hub exposes approval
  request/decision messages.
- Artifact shelf that fails closed until the hub exposes scoped artifact events
  and read access.

Open follow-up beads for those hub protocol gaps:

- `psfn-framework-qa4`: approval request/decision messages
- `psfn-framework-3eh`: scoped artifact events and read access
