import { describe, expect, expectTypeOf, it } from 'vitest';
import { restoreSnapshotSection } from './turn-record-snapshot-view.js';
import { toRecordView } from '../../shared/utils/types.js';

/**
 * Regression pins for the audited type seams introduced by bead
 * psfn-framework-aylm.5. Both helpers must be pure identity functions at
 * runtime (the diet modules rely on reference-preserving surgery for their
 * "input record is not mutated" guarantees) and must carry the documented
 * type shapes: widening to a record view, and narrowing a restructured view
 * back into the destination snapshot slot's declared type.
 */
describe('turn-record snapshot view seams', () => {
  it('toRecordView is a runtime identity that widens to a record view', () => {
    const section = { channelId: 'chan-1', recentEntries: [{ id: 1 }] };
    const view = toRecordView(section);
    expect(view).toBe(section);
    expectTypeOf(view).toEqualTypeOf<Record<string, unknown>>();
  });

  it('restoreSnapshotSection is a runtime identity typed by the destination slot', () => {
    interface DemoSection {
      channelId: string;
      recentEntries?: Array<{ id: number }>;
    }
    const view: Record<string, unknown> = { channelId: 'chan-1' };
    // Contextual inference: the destination slot type (as in the diet modules'
    // snapshot write-backs) drives T; the value itself is untouched.
    const restored: DemoSection | undefined = restoreSnapshotSection(view);
    expect(restored).toBe(view);
    expectTypeOf(restored).toEqualTypeOf<DemoSection | undefined>();
  });
});
