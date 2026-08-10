import { describe, expect, it } from 'vitest';
import {
  COGSEC_MODES,
  COGSEC_VECTORS,
  cogSecVectorForProvenance,
  resolveCogSecProvenanceClass,
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
});
