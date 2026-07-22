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

The legacy direct-Hub protocol reference is:

```text
../PSFN-Satellite-Hub/src/ts/shared/protocol.ts
```

The local client mirror lives in:

```text
src/lib/protocol/events.ts
src/lib/protocol/framing.ts
```

The shipped shared-display entrypoint does not emit that legacy protocol. Its
realtime source of truth is the gateway-owned Companion UI action contract in
`../src/boundary/fleet-auth/companion-ui-action.ts`; the Hub terminates the
same-origin browser connection and authenticates the backchannel to that
gateway adapter. The legacy mirror remains as a strictly validated view/event
adapter and protocol regression surface.

## Runtime Configuration

The browser has no deployment-authority configuration. Production serves the
app on the canonical same-origin HTTPS path `/companion-ui/`; the app reads
fleet session state from `/v1/fleet-auth/session/status` and accepts only an
exact server-issued `/companion-ui/companions/<uuid>/ws` path on that origin.
There is no build-time Hub URL and no editable Hub, device, session, channel,
or credential field.

The browser emits no `hello` and no device/session/channel authority. Human
identity comes from the fleet session, while a strict `session.ready` frame
provides server-owned device/place presentation and the physical capability
ceiling. Those identities are displayed separately and neither authentication
nor reconnection claims primary embodiment.

Default capabilities are text input; text, subtitle, artifact, and
tool-activity output; interrupt, presence, session-attach, approvals, and touch
control; and confirmation-required plus local-only safety. The hub only relays
the approval, artifact, and tool-activity families to satellites that advertise
them, so absent an ack those surfaces stay fail-closed.

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

Build output goes to `dist/`. Static manifest and icon sources are in `public/`.
Vite renders the production `dist/sw.js` from `service-worker/sw.js`, injects
the current hashed asset list, and versions its cache with
`COMPANION_UI_BUILD_REVISION`. Container builds set that value to the pinned
source commit; local builds fall back to a deterministic bundle hash.
Updates activate without navigating an open client. The current page keeps its
draft, selected attachments, and live session state, and
shows an update-ready notice so the operator can reload at a safe point.
The client checks for a new worker at startup, once per minute, and when the app
returns online or to the foreground, so a deployed build is ready before that
operator-chosen reload.
Clients still controlled by the original cache-first worker recover during the
first operator navigation to `/companion-ui/`: the client retires only the
known legacy root registration, and the replacement worker removes its legacy
cache and redirects only a foreground client already at the canonical shell.
Generated-worker updates remain passive and never navigate an open client.

Every production URL is rooted at `/companion-ui/`. The service worker is
registered with that exact scope and handles only the query-free shell and its
build-generated static allowlist. Fleet, Garden, callback, authentication,
WebSocket, query-bearing, credential-header, and no-store request traffic stays
on the browser network. Online shell responses are never written to Cache
Storage; offline mode serves only the build-time unauthenticated shell.

## Emotion Sprite Sheets

The floating companion sprite can render packed sprite-sheet art driven by the
runtime state model, falling back to the built-in CSS face whenever the sprite
manifest is missing or malformed (fail-visible, never blank).

- **Taxonomy** (`src/lib/sprites/taxonomy.ts`): the frozen id space — 16
  emotional bases x 2 crops (mini head / full-body avatar), 7 tool-activity
  domains x 3 phases (started/completed/failed), 3 touch reactions. This is the
  single source of truth shared by the generator, the manifest, the runtime
  catalog, and the tests.
- **Manifest** (`src/lib/sprites/manifest.ts`): `buildSpriteManifest()` is pure
  and deterministic and defines the consumer contract — sheets (grid geometry,
  lazy flag), entries (frame indices, fps, loop), and provenance. The runtime
  loads the serialized `public/sprites/manifest.json` and never regenerates it.
- **Catalog** (`src/lib/sprites/catalog.ts`): `resolveSpriteEntryId()` maps a
  runtime state to a manifest entry (priority: touch > tool > emotional base).
  This is the seam sprite v2 (bead 7ang.3) extends once the redacted
  `emotion.snapshot` and tool-domain signals land; the entry ids are
  art-agnostic.

### Placeholder art (current) and swapping in final art

The committed sheets under `public/sprites/` are **programmatically generated
placeholder art** — flat-coloured, labelled frames, one per manifest frame,
with a `PLACEHOLDER` watermark and `placeholder: true` provenance on every sheet
and entry in the manifest. Nothing ships pretending to be final art.

Regenerate them with:

```bash
npm run sprites:generate
```

To swap in real art, replace each PNG in `public/sprites/` with a final sheet
that honours the same grid (`cols` x `rows`, `frameSize`) and frame ordering
from the manifest — the swap is file-for-file with no code change — then set
`placeholder` to false where the manifest is built. Real art is produced offline
via the Satellite-Hub fal.ai sprite pipeline (satellite-side, out of scope for
this package); only the packed sheets and manifest are consumed here.

## In-Cluster Test Deployment

For a browser-reachable test of this PWA against an in-cluster Satellite Hub,
the repo ships an optional static web container and Helm workload. This is a
stopgap test surface, to be replaced by a packaged app; it serves the built
`dist/` tree only and holds no server logic.

- Image: `docker/companion-ui/Dockerfile` (multi-stage — builds this package,
  serves only `/companion-ui/` with a pinned `nginx-unprivileged` base on port
  8080 as uid 999).
- Build script: `docker/companion-ui/build-image.sh` (ARM64 by default for the
  Pi; commit-tied tag; refuses dirty tree and floating tags).
- Chart workload: `companionUiTest.enabled` in `deploy/helm/psfn` (disabled by
  default, pinned image enforced, ClusterIP Service, optional Ingress,
  egress-denied NetworkPolicy).

The full build/import/enable/reach flow is documented under "Companion UI Test
Surface" in `deploy/helm/psfn/README.md`.

## Validation

Use these checks for this package:

```bash
npm run test
npm run test:browser
npm run typecheck
npm run lint
npm run build
npm audit --omit=dev
```

The browser gate runs the legacy-root-worker-to-scoped-worker migration and a
deterministic fake OAuth/Hub lifecycle in real Chromium. It proves fresh
connections across login and user switch, authority clearing on logout,
revocation and offline transitions, fleet/Garden/callback pages remain
uncontrolled, and cache keys, bodies, browser stores, URLs, and protocol frames
contain no authority secrets. It also verifies install, update, rollback, and
offline reloads. Install the pinned Playwright Chromium runtime once with
`npx playwright install chromium` when preparing a fresh test machine.

For tracked repo work, the parent repository requires `npm run lint` before
closing the bead. Run that from the repo root:

```bash
cd ..
npm run lint
```

## Wire Protocol

Browser action frames have the exact top-level shape
`{schemaVersion, requestId, action, resource, body}`. The UI currently emits:

- `conversation.interact`
- `conversation.interrupt`
- `conversation.touch`
- `confirmations.resolve`
- `artifact.preview`

The authenticated gateway sends only:

- one exact server-owned `session.ready` attachment presentation;
- one exact correlated `result` for each action.

Unknown, replayed, uncorrelated, discriminator-only, or structurally malformed
frames fail closed and close the socket. Action bodies reject browser-supplied
human, companion, device, place, session, channel, credential, and primary-
embodiment authority. The retained legacy Hub mirror also validates every
known inbound and outbound family as an exact structure.

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
  listening, thinking, tool-use, or error. Tapping her gives immediate local
  headpat feedback; taps are coalesced for three seconds and sent as one bounded
  typed interaction through Satellite Hub.
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
conversation record.

Browser voice follows the gateway-owned contract, capability-gated and
fail-closed:

- Spoken-reply **playback** is wired. When the negotiated session ceiling
  advertises the `streamed_audio` output capability, the client reassembles the
  hub's bracketed audio stream (`audio-init` text signal, base64 `audio` frames,
  `audio-end` text signal) into whole utterances, decodes them through Web
  Audio, and plays them back. The decoded amplitude drives v1 lipsync — the
  floating sprite's mouth opens on the companion's speech (amplitude only, no
  visemes). A server interrupt/pause or an assistant interruption stops playback
  (barge-in). Audio that arrives outside a bracket, malformed base64, or a reply
  over the size ceiling is dropped, never played. Sessions without the
  `streamed_audio` ceiling buffer no audio at all, so playback stays inert and
  text remains the source of truth.
- Outbound mic **capture** (getUserMedia + downsample to 16k PCM, or browser
  speech-to-text feeding the gateway `conversation.audio` transcript action) is
  not wired in this build yet; the Voice Chat toggle surfaces a fail-closed
  notice. The reassembly and amplitude/lipsync primitives live under
  `src/lib/audio/`.

Approval and artifact UI is contextual only. It does not live as a permanent
section on the main page. Approval cards (approve/deny with an expiry
countdown and resolved state) and the artifact shelf (with scoped preview
fetch) render in the contextual toast layer above the composer once the hub
acks the matching capability; absent that ack they stay fail-closed and empty.
Tool-activity lifecycle events fold into the redacted Activity drawer.

The client side is wired against the pinned hub contract in:

- `psfn-framework-qa4`: approval request/decision messages
- `psfn-framework-3eh`: scoped artifact events and read access
