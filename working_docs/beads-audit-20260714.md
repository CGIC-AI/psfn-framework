# Open-Beads Audit — 2026-07-14

384 open + 15 in-progress audited by 8 cluster agents. Sprint-10 in-flight family excluded per operator. All dispositions are PROPOSALS — nothing closed/merged without operator approval.

Legend: KEEP (distinct, stays) · FOLD(x→y) (merge x into canonical y) · VTC (verify-then-close, evidence cited) · OBSOLETE (superseded by decision) · LINK (add related-link only)

## Cluster 1: trust / cogsec / contacts / concerns (complete)

Headline: the "hidden memories" class split is already clean — `pdjd` (pre-policy access predicates), `jy6s` (reflection-mode zeroing), `opl1.11-16` (admin under-gating, opposite direction), `0ggv.2` (write-side) are four genuinely distinct axes. No folds proposed in this cluster.

- VTC: **tsyo** (provenance persistence — code done at f8ae97fd, shipped e614380: postgres-store.ts:201,364,381-412 write + :618/778/935 hydrate) and **0zd9** (legacy lanes set sourceContactId, speaker-routing.ts:130-134,159-163, 4 tests). Both held only on the live `scanned>0` post-restart check — close together after the fbfe deploy validation.
- Confirmed still open: **ybzz** (graph-builder-worker.ts:262,293 still lack routedContactId fallback).
- KEEP (distinct pairs that look like dups but aren't): pdjd/jy6s · ys51/189d (mechanics vs language; rename is canonical in 189d) · ys51/189d/w05a.11 triangle · 27ut/ipw1 · 0zd9/ybzz · u8iv/vrmf/tlnd · zlve/w05a-ruminationWatch.
- OBSOLETE: none — today's beads encode the 07-14 decisions rather than colliding with them.
- LINK: zlve↔w05a.11, zlve→ys51/hgw3 · jy6s↔opl1.16 (reflection gating, opposite directions) · hr1q↔0ggv.4 · 9c4k→u8iv (test-session naming is the root cause of the test-channel leak).

## Cluster 2: Garden / Loom / dashboards / telemetry (complete)

Headline: **11-bead duplicate batch.** Epic `efc2` (Garden UX wave 1, 16/16 children CLOSED, code on branch `garden-ux-cleanup` awaiting operator preview review ~07-19) created exact-title twins of loose 2026-07-10 beads that were never closed.

- FOLD (close as duplicates when efc2 merges): **1hr8** (→v83d, which explicitly absorbs it), **ujbl, obvz, jk93, tq5g, mbs6, 0c22, 46v9, gmri, 624s, h0od** (→ their closed efc2 twins; 624s+h0od are also dups of each other).
- VTC: **vi2i** (values reflection journals — code done 79494c11, shipped e614380; hold on cquq weekly-reflection validation).
- KEEP distinct: hgw3.9 vs qz9e (same `admin-ui run check` gate, different files — LINK and ship together) · vbow/wq8o (wave-2 follow-ups) · t5z7 children · 3v0/PSFNLIVE-gkr (distinct observability surfaces; future epic could gather 3v0+gkr+zlve+wq8o).
- Reparent answer: **jsi9 stays with hgw3** (write-side turn-record diet, consistent with auiu/9ree), NOT under v83d.
- Cross-cluster: qz9e carries icp label — coordinate with S10 owners before closing; v26r flags vinz.27/vinz.4 as verify-close and vinz.28 as re-scope (S10 family, operator to decide).

## Cluster 3: memory & episodic (complete)

- FOLD: **peq** → m14v (per-type half-lives) + 2z12.10 (sweep cadence) — stale 06-26 one-liner, both halves now fully specified with operator decisions. (Independently confirmed by the scheduler cluster.)
- KEEP: jy6s/pdjd (the class-defining pair) · 27ut→ipw1 chain gated by tsyo · be3f→depends 6i7c+x9ka · awfr/lq1f (LINK: lq1f is the wiki-flag execution of awfr's decision).
- VTC: only **tsyo** (same live `scanned>0` hold as cluster 1).
- Actively DISPROVED as done (keep open): **z5vd** (dead proactive-recall wiring still at retrieval.ts:1299), **z7qe.1** (better-sqlite3 remnants still across store.ts/episodic), m14v/2z12.10 unimplemented (halflife table unchanged).
- Deferred-family note: PSFN-cyzi/z80i/bin3 (April L0.1 landmark vision) are superseded by x9ka/6i7c/apq0 — never revive as fresh work.
- Optional: umbrella epic for the 07-14 prompt-audit memory set (jy6s, kb9j, i3yx, 6i7c, 3zu5, dtym, m14v, apq0, x9ka, be3f).

## Cluster 4: scheduler / temporal / efficiency (complete)

- FOLD: **peq** (as above) · **lp7g** → mmo9.3 (self-describes as mmo9.3's subject — the durable BackgroundWorkSupervisor structurally solves the drain race lp7g patches).
- KEEP with LINK: dvzq↔mmo9 (dvzq = quick fix for 60s ceiling; mmo9.3 = wave-2 architecture, same class-A/B model) · 2lw8/7toj (same subsystem, different defects) · kz0i/7grh (7grh is kz0i's habit-fallback root) · nrcz/2z12.12 complementary (rename vs bundling+transparency) · la3m + dnll.3 coordinate with the bundled-tick redesign.
- Reparent: **auiu, 9ree, jsi9 → under hgw3** (the explicitly-deferred turn-record-diet remainder; currently standalone) · gjhk → link hgw3.4+fbfe · 2lw8/7toj/6ahp → link 2x37.
- Verified: hgw3.1-.4/.6-.8 correctly closed and shipped (PR#43); **auiu genuinely open** (static prompt still ~190KB/turn ×4-5 copies); 2x37 epic closable once .8/.9 land.
- Genuinely open P1 pair, no overlap: cquq (weekly reflection never fires — relative cadence resets on restart) and b9kb (Garden writes heartbeat-policy at wrong root).

## Cluster 5: tools / skills / shards / workbench (complete)

- FOLD: **nt53 → x5rt.5** (both "kube-aware lifecycle tool"; x5rt.5 is the fuller spec, nt53's fail-closed-disable is its minimum slice; verified lifecycle.ts still has zero kube handling) · **vvf.1 → b0yl.1** (obsoleted by the 07-14 decision — it edits the detached block b0yl is retiring).
- NARROW: **6l1** to its unique residue (per-model JSON-vs-XML formats, tools-as-skills reframe, audit-with-her) — description/usage-inventory halves superseded by b0yl.1/.5.
- Reparent: **zkwr → under 7ym.8** (shard goal-mode epic; zkwr is its missing goal-document child) · e7s0+ge7g → link c1dh (same kube self-test triage) · LINK b0yl↔vvf/7ym coordination so the two tooling waves don't diverge · b0yl.7↔i72.2 (skill-authoring verify) + 7ym.1 (plan-anchor ≈ north_star proposal).
- Confirmed: mihm already closed (retry shipped); **h7g9.1 NOT covered by it** (live-runtime verification never ran — keep open). Still-open verified: x5rt.5, 98xm.5 (shard tool still "future" in registry), 2oex (vault tool zero callers).

## Cluster 6: companion experience & identity (complete)

- KEEP (asked-and-answered distinctions): i3yx vs o75r (user-message re-injection vs base-prompt persona — different layers) · kb9j vs 3zu5 (prompt INPUT diet vs memory OUTPUT atomicity — opposite pipeline ends, disjoint files) · gmri vs vi2i (same page, distinct features — but gmri has an EMPTY description, needs fleshing or falls in the efc2 fold from cluster 2).
- LINK/sequence (colliding edits): 189d+ys51 (rename canonically owned by 189d) · i3yx+kb9j (i3yx owns the persona-block cut inside kb9j's diet) · cf5y+189d+kb9j all edit the reflection/internal-state injection — land coordinated.
- VTC: **vi2i** (confirmed again; gated on cquq).
- Verified NOT done: **fpiu** (working-tree change only extracts the guard; block-not-heal still live at turn-execution-runtime.ts:1043-1047) · **w3rr** (UTC dates still emitted).
- Soft option: the 07-14 reflection/prompt-quality wave (i3yx, kb9j, 189d, cf5y, dcnu, 3zu5, ys51, 6vfh, o75r, jy6s) could group under the 031 experience epic.

## Cluster 7: channels / voice / fleet / kube (complete)

- FOLD: **liql → 2nu6** (same ChatGPTN template-artifact bug; both beads flag each other; 2nu6 carries the quantified evidence) · **nt53 → x5rt.5** (independently confirms cluster 5) · **8t5f → opl1** (design-seed subsumed by the epic + children .1/.3/.7/.9).
- RE-SCOPE: **sj4i** (oldest vaguest empty-response bead) → absorbed by the lghd/2nu6/343f/zfqg family once one lands; link now, close then.
- KEEP: fr03/mpwv (same fix, different bots) · 2z12.11/7toj/2x37.9 (distinct concerns, same functions — land together).
- Bonding mini-chain: **vrmf parent, tlnd + u8iv prerequisites** — suggest making it an explicit epic or dep-links; tlnd's gating half is a LIVE behavior fix (global mirroring, empty overrides).
- LINK: w05a.12 → dnll (per-companion settings pattern).
- No VTC candidates; verified still-open: engc, vrmf (no bonding scaffolding), u8iv/tlnd.

## Cluster 8: infra / persistence / backups / hygiene (complete)

- FOLD: **00xl → jmnr** (same dolt-push hang; jmnr fuller) · **esv9 → w8xs + h5zn** (its two symptoms are exactly those two beads; live DB already hot-fixed) · **l1qz → lk0a** (same identity-literals gate; lk0a anchored to origin/main) · **dbr0 → 8wf5** (byte-identical titles) · **624s/h0od** exact dups (also in cluster-2 efc2 fold).
- KEEP sequenced: **80f6 → feeds auiu** (complementary, not dup — wire capture vs static-prefix dedup).
- Verified NOT done (keep open): z7qe.1 (better-sqlite3 still across memory/episodic/gateway-audit), **upx0.9** (research-library still exists AND its "zero callers" premise is now stale — artifact-lifecycle imports its types; re-verify before deleting), z5vd, z7qe.6 (all three items present).
- Reframe: **upx0.11** decision already made 07-10 (option a) — now pure implementation, companions under z7qe.
- Reparent/LINK: auiu+80f6+9ree+jsi9 → hgw3 family · ipw1 depends-on 27ut · o968 → upx0.4 (engc keeps its distinct cwd-path bug) · pulo → m82u · nljc↔b9kb↔nudf owner-file-loading trio · edtz↔zl7f (zl7f residual = authority-policy question) · je3 → under upx0.21 (its "wait for sprint_9_memory" gate is satisfied — unblocked).

---

# Consolidated action plan (operator approval required)

## Batch A — close as duplicate/superseded (~22 beads)
efc2 twins (11): 1hr8→v83d · ujbl, obvz, jk93, tq5g, mbs6, 0c22, 46v9, gmri, 624s, h0od → closed efc2 children.
Cross-verified folds (11): peq→m14v+2z12.10 · lp7g→mmo9.3 · nt53→x5rt.5 · vvf.1→b0yl.1 · liql→2nu6 · 8t5f→opl1 · 00xl→jmnr · esv9→w8xs+h5zn · l1qz→lk0a · dbr0→8wf5 · (sj4i: link now, close when empty-response family lands).
Each close carries a comment naming the canonical bead + any residue carried over (nt53's no-silent-no-op acceptance line → x5rt.5; vvf.1's hints → b0yl.1; zl7f mechanics → edtz keeping zl7f's policy question).

## Batch B — verify-then-close (hold, do not close yet)
tsyo + 0zd9 (live scanned>0 after fbfe deploy) · vi2i (after cquq weekly reflection fires) · 2x37 epic (after .8/.9).

## Batch C — reparent/links (~20 link ops, non-destructive)
auiu/9ree/jsi9/80f6→hgw3 · zkwr→7ym.8 · ipw1→27ut · o968→upx0.4 · je3→upx0.21 · e7s0+ge7g→c1dh · pulo→m82u · links: qz9e↔hgw3.9 · 7grh↔kz0i · be3f→6i7c+x9ka+hgw3 · zlve↔w05a.11/ys51/2z12.12 · b0yl↔vvf/7ym · nljc↔b9kb↔nudf · edtz↔zl7f · w05a.12→dnll · 9c4k→u8iv · jy6s↔opl1.16 · gjhk→hgw3.4+fbfe · sj4i→lghd/2nu6 family · vrmf/tlnd/u8iv bonding chain links.

## Batch D — narrow/rescope (needs a sentence of editing each)
6l1 → unique residue only · upx0.11 → decision→implementation reframe · upx0.9 → re-verify callers before delete · gmri → flesh out or ride the efc2 fold.

## Bottom line
384 open → ~22 closable now as dups, 4 verify-then-close in flight, rest genuinely distinct. The tracker is healthier than it looked: the real problems were one unclosed twin batch (efc2 wave), a handful of self-identified merge pairs nobody executed, and missing parent links on the turn-record-diet family.

## EXECUTED 2026-07-14 (operator-approved batches A, C, D)
- Batch A: 22 closed as duplicate/superseded, each with canonical bead + residue carried (nt53's acceptance → x5rt.5 notes; vvf.1's hints → b0yl.1 notes). Also closed en route (folded earlier in the day, pre-audit): none beyond the 22.
- Batch C: 9 reparents (auiu/9ree/jsi9/80f6 → hgw3 diet family; zkwr→7ym.8; o968→upx0.4; je3→upx0.21; e7s0/ge7g→c1dh), 8 blocks-deps (incl. 80f6 blocks auiu; tlnd+u8iv block vrmf; hgw3.9 blocks v83d.1), 24 relates-to links.
- Batch D: 6l1 narrowed, upx0.11 reframed decision→implementation, upx0.9 stale-premise caveat added.
- Batch B held open as designed: tsyo+0zd9 (live scanned>0), vi2i (cquq), sj4i (empty-response family), 2x37 epic (.8/.9).
- Open count: 384 → 357.
