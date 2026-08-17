import { describe, expect, it } from 'vitest';
import {
  COGSEC_CHANNEL_CLASSES,
  COGSEC_MODES,
  COGSEC_SURFACE_POSTURES,
  COGSEC_VECTORS,
  COGSEC_WORKFLOWS,
  cogSecVectorForProvenance,
  resolveCogSecProvenanceClass,
  resolveCogSecSurfacePosture,
  resolveCogSecVectorPosture,
} from './cogsec-mode.js';

describe('canonical CogSec enforcement matrix', () => {
  it('classifies every declared vector in all three modes', () => {
    for (const mode of COGSEC_MODES) {
      for (const vector of COGSEC_VECTORS) {
        const posture = resolveCogSecVectorPosture(mode, vector);
        if (mode === 'shadow') expect(posture).toEqual({ screens: true, enforces: false });
        if (mode === 'strict') expect(posture).toEqual({ screens: true, enforces: true });
        if (mode === 'boundary') {
          const external = vector.startsWith('external_') || vector === 'outbound_publication';
          expect(posture).toEqual(external
            ? { screens: true, enforces: true }
            : { screens: false, enforces: false });
        }
      }
    }
  });

  it('attributes external chat, file, and web ingress distinctly', () => {
    expect(cogSecVectorForProvenance('external', 'regular_contact')).toBe('external_chat_ingress');
    expect(cogSecVectorForProvenance('external', 'document')).toBe('external_file_ingress');
    expect(cogSecVectorForProvenance('external', 'web_fetch')).toBe('external_web_ingress');
  });

  it('cannot launder external bytes through an internal provenance hint', () => {
    expect(resolveCogSecProvenanceClass({
      sourceClass: 'web_fetch',
      structuralProvenance: 'local_fs_read',
    })).toBe('external');
    expect(resolveCogSecProvenanceClass({
      sourceClass: 'tool_output',
      structuralProvenance: 'local_fs_read',
    })).toBe('local_fs_read');
  });

  it('resolves owner-configured channel and workflow posture without a global weakening', () => {
    const matrix = {
      channelClasses: {
        operator_direct: 'shadow_full',
        private_direct: 'enforce_full',
        group_chat: 'fast_pass_post_escalate',
        public_channel: 'enforce_full',
      },
      workflows: {
        chat_ingress: 'enforce_full',
        file_ingress: 'enforce_full',
        web_fetch: 'enforce_full',
        web_search: 'enforce_full',
        outbound_publication: 'enforce_full',
        internal_activity: 'shadow_full',
      },
    } as const;

    expect(resolveCogSecSurfacePosture(matrix, { channelClass: 'operator_direct' })).toEqual({
      profile: 'shadow_full',
      screens: true,
      enforces: false,
      deepScreening: 'inline',
    });
    expect(resolveCogSecSurfacePosture(matrix, { channelClass: 'group_chat' })).toEqual({
      profile: 'fast_pass_post_escalate',
      screens: true,
      enforces: false,
      deepScreening: 'post_pass',
    });
    expect(resolveCogSecSurfacePosture(matrix, { workflow: 'web_search' }).enforces).toBe(true);
  });

  it('keeps channel classes, workflows, and profiles closed and rejects unknown surfaces', () => {
    expect(COGSEC_CHANNEL_CLASSES).toEqual([
      'operator_direct', 'private_direct', 'group_chat', 'public_channel',
    ]);
    expect(COGSEC_WORKFLOWS).toContain('web_search');
    expect(COGSEC_SURFACE_POSTURES).toContain('fast_pass_post_escalate');
    expect(() => resolveCogSecSurfacePosture({
      channelClasses: {} as never,
      workflows: {} as never,
    }, { workflow: 'unregistered_workflow' as never })).toThrow(/Unknown CogSec workflow/);
    expect(() => resolveCogSecSurfacePosture({
      channelClasses: {} as never,
      workflows: {} as never,
    }, {})).toThrow(/exactly one structural surface/);
  });
});
