/**
 * The single audited narrowing seam for the turn-record diet modules
 * (bead psfn-framework-aylm.5).
 *
 * Why it exists: the persisted form of a turn-snapshot section legitimately
 * diverges from its in-memory contract type while a diet ref stands in for an
 * inline field — `recentEntriesRef` for `sessionContext.recentEntries`
 * (turn-record-session-refs.ts), `candidatesRef` for the four
 * `snapshot.memory` candidate arrays (turn-record-memory-refs.ts), and
 * `toolDefinitionsRef` / `bodyRef` / `staticPrefixTemplateRef` for the
 * content-addressed sidecar payloads (turn-record-shared-store.ts).
 * TypeScript cannot express "the declared section type OR its ref-carrying
 * persisted projection", so each diet module used to round-trip
 * `section as unknown as Record<string, unknown>` → restructure →
 * `as unknown as NonNullable<typeof snapshot.X>` at every write-back site.
 * Those scattered round-trips are contained here instead: the widening
 * direction goes through `toRecordView` (src/shared/utils/types.ts) and the
 * narrowing direction through this helper, once.
 *
 * INVARIANT every caller relies on: the record view passed in is the SAME
 * snapshot section it was read from (or a restructured spread of it),
 * destined for the SAME snapshot slot — the only shape change between read
 * and write-back is the inline⇄ref field substitution of that section's
 * diet. The section is plain JSON-ish persisted data (it round-trips through
 * JSONL), so the record view observes exactly the structure persistence
 * does. Do not use this to convert unrelated values into snapshot sections.
 */
export function restoreSnapshotSection<T>(view: Record<string, unknown>): T {
  return view as T;
}
