# Visual comparison — psfn-framework-3pr4k (Magic Patterns login across Garden auth surfaces)

Design source of truth: Magic Patterns project `gpkjwgpcw9ex6tq43nvvvd`,
artifact `7d5a7b67-f0c2-4aa1-b71b-e5d54f95ef12` (active artifact, re-verified
via `get_design_status` on 2026-08-10), component `pages/Login.tsx`, tokens from
`tailwind.config.js` / `index.css` (canvas `#FAF8F3`, surface `#FFFFFF`, sunken
`#F4F1E8`, line `#E6E0D2`, ink `#26231E`, muted `#7C7364`, gold scale, Fraunces
display / Inter sans stacks, card shadow `0 1px 2px / 0 1px 12px rgb(38,35,30)`).

## Method

- Harness: Playwright 1.61.1 (`@playwright/test` from `companion-ui`), Chromium
  headless shell 149.0.7827.55.
- Viewports: mobile 390x844, desktop 1440x900.
- `admin-login-*`: admin-ui production build (`npm run build`,
  `@sveltejs/adapter-static`) served statically with SPA fallback, routed to
  `/login`.
- `gateway-fleet-login*`: real HTML emitted by `GatewayFleetLoginLanding.send()`
  (captured through a mock `ServerResponse`), default and break-glass
  (`/break-glass/login`) registrations, served statically.
- `garden-standalone-login*`: real HTML emitted by `sendGardenLoginPage()` with
  and without the `Invalid token` error block.
- Every capture asserted `document.documentElement.scrollWidth - clientWidth === 0`
  (no horizontal overflow) and zero page JS errors; all passed.
- Focus captures: one `Tab` from page load — gateway landing focuses the Discord
  anchor, standalone Garden login focuses `#token`; gold focus ring is visible in
  `gateway-fleet-login-focus-mobile-390.png` and
  `garden-standalone-login-focus-mobile-390.png`.

## Comparison against the MP artifact

Translated 1:1 from `pages/Login.tsx`:

- Brand block: gold-tinted rounded-xl tile with serif `P`, serif `PSFN`
  wordmark, muted product line (`Cluster Portal` on the gateway landing,
  `<Companion>'s Garden` on the Garden surfaces).
- Gold-to-line gradient hairline rule under the brand block.
- Serif display heading `Welcome back.` with muted supporting copy.
- Primary action: full-width, 48–52px tall, rounded-xl — Discord blurple
  `#5865F2`/`#4752C4` with the Discord mark on the fleet landing (SSO), Garden
  gold `garden-action--primary` on the token surfaces (token auth).
- Lock-glyph privacy note under the primary action.
- admin-ui desktop split: left sunken showcase panel with the MP quote and a
  three-cell posture `<dl>`; the MP remote engraving image is replaced with a
  pure-CSS gradient/hatch treatment because both delivery boundaries forbid
  remote assets.
- Break-glass link, when explicitly registered, separated by a hairline with a
  44px-tall tap target.
- Reduced-motion: transitions removed under `prefers-reduced-motion: reduce`
  on all three surfaces (admin-ui inherits the global rule in `app.css`).

Fonts render with local fallbacks (Georgia serif / system sans) in this headless
environment; the font stacks name Fraunces/Inter first exactly as the Garden
tokens and MP artifact do, and neither surface fetches remote fonts
(`font-src 'none'` on the gateway landing).

## Outcome

Both production entry paths — local token `/login` (Svelte page and standalone
server-rendered variant) and `/fleet/login` + unauthenticated `/fleet` —
visibly share the MP/Garden login language at 390px and 1440px with no
horizontal overflow, no client JS on the gateway landing, and visible keyboard
focus. Screenshots in this directory are evidence only and are intentionally not
committed as binaries.
