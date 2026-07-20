# Shakedown

Versioned artifacts for the post-sprint live shakedown. **The process is documented in one place: [`docs/shakedown.md`](../docs/shakedown.md).** Do not add process docs here.

Contents:

- `artie/ARTIE.png` — character card (v2) for ARTEMIS ("Artie"), the test companion. Imported via `npm run import-character` when bootstrapping a fresh shakedown runtime. Her persistent runtime lives on the local kube cluster; local runtime instances are disposable clones of this card.
- `support/` — synthetic Mica/Lumen cards, the canonical Artie+support fleet template, and the mechanics for disposable local support-companion stand-up/teardown.
- `artie/shakedown.env.template` — env overlay template for an isolated local shakedown runtime. Copy to the round root, fill `OPERATOR-CONFIRM` values, source after the live secrets env.
- `harness/` — the scripted Layer A harness (case harness, tier sweep, Garden sweep, scorecard) with a shared probe library and fail-closed env; see [`harness/README.md`](./harness/README.md). Case authoring for the current sprint continues under epic `psfn-framework-65rk`.

Round artifacts (run JSONs, screenshots, interviews) live outside the repo in the per-round directory — only process, harness, and Artie's bootstrap artifacts are versioned here.
