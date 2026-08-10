# psfn-framework-gh62x — /fleet narrow-rail shell visual evidence

Design source: Magic Patterns project `gpkjwgpcw9ex6tq43nvvvd`, active artifact
`7d5a7b67-f0c2-4aa1-b71b-e5d54f95ef12` (re-verified via `get_design_status` on
2026-08-10), components `components/IconRail.tsx` (narrow rail pattern),
`pages/Cluster.tsx` (cluster page frame), `data/navigation.ts`, `index.css`,
`tailwind.config.js`, `components/PageHeader.tsx`, `App.tsx` (shell
composition).

## Method

`capture-fleet-shell.mjs` serves the production `admin-ui/build` SPA over a
local HTTP server that mocks the fleet API surface (`/v1/fleet/portal`,
`/v1/fleet/model-usage`, per-companion `api/admin/image-references` with
up/down/unknown transports) and drives Chromium 1228 via the repo-pinned
Playwright 1.61.1 (companion-ui devDependency; binary already present in the
local Playwright cache). Fixtures exercise healthy, stale-posture,
down-transport, unknown-health, and unavailable-posture companions so the
truthful-state distinctions are visible.

## Captures

- `desktop-1440-info.png` — 1440x900, `/fleet`: slim w-16 cluster rail with
  filled-ink cluster identity (active), icon destinations, sign-out pinned to
  the rail bottom; Garden page header, metric cards, companion health cards
  inside the inherited 100rem frame.
- `desktop-1440-usage.png` — 1440x900, `/fleet?view=usage`: usage destination
  active with gold rail treatment; FleetUsageSummary renders real (mocked)
  totals.
- `desktop-1440-firewall.png` — 1440x900, `/fleet?view=firewall`:
  FleetGlobalFirewall explicit unavailable/empty states remain
  explicit and non-disclosing.
- `mobile-390-info.png` — 390x844, `/fleet`: no rail; compact "Menu" trigger
  bottom-left; no floating sign-out; single-column content, no overflow.
- `mobile-390-drawer.png` — 390x844, drawer open: cluster identity header
  ("Garden Cluster · All companions · no companion selected"), the four fleet
  destinations with active state, sign-out in the drawer footer.
- `desktop-1440-overflow-check.png` / `mobile-390-overflow-check.png` —
  horizontal overflow measured via `scrollWidth - clientWidth`: 0px at both
  widths.

## Comparison outcome vs the Magic Patterns source

- Rail geometry (w-16, 10x10 rounded-xl icon buttons, gold active pill,
  filled-ink cluster identity button, hover tooltips, bottom-anchored sign-out)
  matches `IconRail.tsx`, translated to Garden tokens (bark/shadow/gold) per
  `tailwind.config.js` -> admin-ui `@theme` mapping.
- Page frame (eyebrow + display title + description header, metric cards,
  companion cards, 100rem ceiling) matches `pages/Cluster.tsx` and
  `components/PageHeader.tsx`.
- Intentional divergence: the MP rail embeds a companion switcher and
  companion-scoped sections; the fleet rail is cluster-scoped only (acceptance
  criterion 3), so the switcher/search/section panel are omitted and every
  destination maps to a real /fleet surface.

Screenshots are intentionally not git-tracked (the repository tracks no
comparable binary evidence); regenerate with:

```
node working_docs/visual-evidence/psfn-framework-gh62x/capture-fleet-shell.mjs
```
