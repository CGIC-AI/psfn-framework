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

The hub URL, session id, and optional channel id are edited in the in-app
Settings drawer, opened from the floating gear button. They are not shown on
the primary chat surface.

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

The primary screen is one continuous relationship thread. There are no
conversation lists, sidebars, top banners, or always-visible debug panels.

- Floating Activity button: opens the Activity / Events drawer.
- Floating Settings button: opens connection, audio, notification, companion,
  and advanced settings.
- Tiny connection indicator: shows the current hub connection state without
  becoming a header.
- Message thread: renders user and assistant text messages, including live
  assistant draft streaming.
- Composer: one rounded surface with a plus button, multiline text input, mic
  control, and send button.
- Floating sprite: reflects high-level local state such as attentive, speaking,
  listening, thinking, tool-use, or error.
- Contextual toast layer: holds errors and any future approval/artifact cards
  above the composer.

## Drawers And Diagnostics

Activity slides over the chat from the left. Settings slides over the chat from
the right. Neither drawer pushes the thread layout or resets its scroll
position. On small screens, drawers cover the full viewport.

Activity is the event-bus transparency surface. It is redacted and secondary by
design. It shows chronological hub events with filters for:

- All
- Messages
- Artifacts
- Approvals
- Voice
- Tools
- System
- Errors

Transcript content is not copied into raw diagnostics.

## Composer Controls

The plus button opens one attachment menu:

- Upload file
- Upload image
- Take photo

Selected files are staged as removable local-only cards above the composer. The
current client does not send file payloads to the hub because the scoped
artifact/file transport is not implemented here yet.

The mic button defaults to Dictation and can toggle to Voice Chat. Both modes
are compact composer states, not separate tabs. Text remains the canonical
conversation record. Browser audio capture and TTS transport are shown
fail-closed until the hub/client voice path is implemented.

Approval and artifact UI is contextual only. It does not live as a permanent
section on the main page. Until the hub exposes those protocol events, the
client keeps them fail-closed.

Open follow-up beads for those hub protocol gaps:

- `psfn-framework-qa4`: approval request/decision messages
- `psfn-framework-3eh`: scoped artifact events and read access
