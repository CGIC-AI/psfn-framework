import { describe, it, expect } from 'vitest';
import type { ConfirmationQueueEntry } from '../../../system/capabilities/confirmation-queue.js';
import {
  projectApprovalRequestedPayload,
  redactApprovalRequested,
  redactApprovalResolved,
  redactArtifactCreated,
  redactToolActivity,
  toCompanionApprovalStatus,
  type ApprovalRequestedV2Context,
} from './redaction.js';

// Sentinels that must NEVER survive redaction. Neutral fixtures only.
const SECRET_PARAM = 'raw-param-secret-token-abc123';
const SECRET_PATH = '/companion-data/private/journal-entry.md';
const SECRET_TRANSCRIPT = 'transcript line the user typed in confidence';
const SECRET_THOUGHT = 'private chain-of-thought reasoning snippet';

function richConfirmationEntry(): ConfirmationQueueEntry {
  return {
    id: 'conf-1234',
    method: 'fs.write',
    action: 'write file',
    scope: '/workspace/todo.txt',
    params: {
      path: SECRET_PATH,
      content: SECRET_TRANSCRIPT,
      apiKey: SECRET_PARAM,
      nested: { reasoning: SECRET_THOUGHT },
    },
    companionReason: 'Updating the shared todo list',
    requestedAt: 1_700_000_000_000,
    expiresAt: 1_700_000_600_000,
  };
}

describe('redactApprovalRequested', () => {
  it('emits only the whitelisted payload keys', () => {
    const payload = redactApprovalRequested(richConfirmationEntry());
    expect(Object.keys(payload).sort()).toEqual(
      ['expiresAt', 'id', 'redactedContext', 'requestedAt', 'status', 'title'].sort(),
    );
    expect(payload.status).toBe('pending');
    expect(payload.id).toBe('conf-1234');
    expect(payload.title).toBe('write file: /workspace/todo.txt');
    expect(payload.requestedAt).toBe(new Date(1_700_000_000_000).toISOString());
    expect(payload.expiresAt).toBe(new Date(1_700_000_600_000).toISOString());
  });

  it('provably strips raw params, file contents, and reasoning', () => {
    const serialized = JSON.stringify(redactApprovalRequested(richConfirmationEntry()));
    expect(serialized).not.toContain(SECRET_PARAM);
    expect(serialized).not.toContain(SECRET_PATH);
    expect(serialized).not.toContain(SECRET_TRANSCRIPT);
    expect(serialized).not.toContain(SECRET_THOUGHT);
    expect(serialized).not.toContain('params');
  });

  it('omits expiresAt when the entry has no finite expiry', () => {
    const payload = redactApprovalRequested({
      ...richConfirmationEntry(),
      expiresAt: Number.NaN,
    });
    expect(payload.expiresAt).toBeUndefined();
  });

  it('truncates oversized titles and context', () => {
    const payload = redactApprovalRequested({
      ...richConfirmationEntry(),
      action: 'a'.repeat(500),
      companionReason: 'b'.repeat(1_000),
    });
    expect(payload.title.length).toBeLessThanOrEqual(160);
    expect(payload.redactedContext.length).toBeLessThanOrEqual(280);
  });

  it('fails closed on a missing id', () => {
    expect(() => redactApprovalRequested({ ...richConfirmationEntry(), id: '  ' })).toThrow(/missing approval id/);
  });

  it('emits the exact v1 shape when no v2 context is supplied', () => {
    const payload = redactApprovalRequested(richConfirmationEntry());
    expect(payload).not.toHaveProperty('sourceSystem');
    expect(payload).not.toHaveProperty('attribution');
    expect(payload).not.toHaveProperty('grantMode');
    expect(payload).not.toHaveProperty('action');
  });
});

const V2_CONTEXT: ApprovalRequestedV2Context = {
  sourceSystem: 'tool-access',
  attribution: { parentId: 'companion-parent-1', parentLabel: 'Parent One' },
  grantMode: { kind: 'once' },
};

describe('redactApprovalRequested v2 (approvals.v2)', () => {
  it('adds the whitelisted v2 fields and never leaks raw params', () => {
    const payload = redactApprovalRequested(richConfirmationEntry(), V2_CONTEXT);
    expect(Object.keys(payload).sort()).toEqual(
      [
        'action', 'attribution', 'expiresAt', 'grantMode', 'id', 'reason',
        'redactedContext', 'requestedAt', 'scope', 'sourceSystem', 'status', 'title',
      ].sort(),
    );
    expect(payload.sourceSystem).toBe('tool-access');
    expect(payload.attribution).toEqual({ parentId: 'companion-parent-1', parentLabel: 'Parent One' });
    expect(payload.action).toBe('write file');
    expect(payload.scope).toBe('/workspace/todo.txt');
    expect(payload.reason).toBe('Updating the shared todo list');
    expect(payload.grantMode).toEqual({ kind: 'once' });

    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain(SECRET_PARAM);
    expect(serialized).not.toContain(SECRET_PATH);
    expect(serialized).not.toContain(SECRET_TRANSCRIPT);
    expect(serialized).not.toContain(SECRET_THOUGHT);
    expect(serialized).not.toContain('params');
  });

  it('carries optional shard provenance when present', () => {
    const payload = redactApprovalRequested(richConfirmationEntry(), {
      ...V2_CONTEXT,
      sourceSystem: 'shard',
      attribution: {
        parentId: 'companion-parent-1',
        parentLabel: 'Parent One',
        shardId: 'shard-xyz',
        shardLabel: 'Research Shard',
      },
    });
    expect(payload.attribution).toEqual({
      parentId: 'companion-parent-1',
      parentLabel: 'Parent One',
      shardId: 'shard-xyz',
      shardLabel: 'Research Shard',
    });
    expect(payload.sourceSystem).toBe('shard');
  });

  it('fails closed instead of presenting an opaque parent id as its label', () => {
    expect(() => redactApprovalRequested(richConfirmationEntry(), {
      ...V2_CONTEXT,
      attribution: { parentId: 'companion-parent-1', parentLabel: '   ' },
    })).toThrow(/parentLabel/);
  });

  it('fails closed on a missing attribution parent id', () => {
    expect(() => redactApprovalRequested(richConfirmationEntry(), {
      ...V2_CONTEXT,
      attribution: { parentId: '  ', parentLabel: 'x' },
    })).toThrow(/attribution parentId/);
  });

  it('refuses to emit a TTL grant mode (no policy yet)', () => {
    expect(() => redactApprovalRequested(richConfirmationEntry(), {
      ...V2_CONTEXT,
      grantMode: { kind: 'ttl', ttlSeconds: 3600 },
    })).toThrow(/TTL grant mode is not permitted/);
  });
});

describe('projectApprovalRequestedPayload (capability gating)', () => {
  it('passes the full v2 payload when the client advertised approvals.v2', () => {
    const v2 = redactApprovalRequested(richConfirmationEntry(), V2_CONTEXT);
    expect(projectApprovalRequestedPayload(v2, { includeV2: true })).toBe(v2);
  });

  it('strips every v2 field back to the v1 subset for an old client', () => {
    const v2 = redactApprovalRequested(richConfirmationEntry(), V2_CONTEXT);
    const v1 = projectApprovalRequestedPayload(v2, { includeV2: false });
    expect(Object.keys(v1).sort()).toEqual(
      ['expiresAt', 'id', 'redactedContext', 'requestedAt', 'status', 'title'].sort(),
    );
    expect(v1).not.toHaveProperty('sourceSystem');
    expect(v1).not.toHaveProperty('attribution');
    expect(v1).not.toHaveProperty('grantMode');
    // identical to what a pure v1 redaction would have produced
    expect(v1).toEqual(redactApprovalRequested(richConfirmationEntry()));
  });

  it('omits expiresAt in the v1 projection when the source had none', () => {
    const v2 = redactApprovalRequested({ ...richConfirmationEntry(), expiresAt: Number.NaN }, V2_CONTEXT);
    const v1 = projectApprovalRequestedPayload(v2, { includeV2: false });
    expect(v1).not.toHaveProperty('expiresAt');
  });
});

describe('redactApprovalResolved / toCompanionApprovalStatus', () => {
  it('maps internal statuses onto the hub protocol statuses', () => {
    expect(toCompanionApprovalStatus('approved')).toBe('approved');
    expect(toCompanionApprovalStatus('modified')).toBe('approved');
    expect(toCompanionApprovalStatus('denied')).toBe('denied');
    expect(toCompanionApprovalStatus('expired')).toBe('expired');
    expect(toCompanionApprovalStatus('failed')).toBe('blocked');
    expect(toCompanionApprovalStatus('failed', true)).toBe('approved');
    expect(() => toCompanionApprovalStatus('not_found')).toThrow(/not_found/);
  });

  it('emits only id, status, resolvedAt', () => {
    const payload = redactApprovalResolved({
      id: 'conf-9',
      status: 'denied',
      resolvedAt: 1_700_000_001_000,
      executed: false,
    });
    expect(Object.keys(payload).sort()).toEqual(['id', 'resolvedAt', 'status']);
    expect(payload).toEqual({
      id: 'conf-9',
      status: 'denied',
      resolvedAt: new Date(1_700_000_001_000).toISOString(),
    });
  });
});

describe('redactToolActivity', () => {
  it('emits only id, tool, phase, timestamp — never detail from runtime data', () => {
    const payload = redactToolActivity({
      toolCallId: 'call-77',
      toolName: 'analysis_workbench',
      phase: 'failed',
      timestampMs: 1_700_000_002_000,
    });
    expect(Object.keys(payload).sort()).toEqual(['id', 'phase', 'timestamp', 'tool']);
    expect(payload.detail).toBeUndefined();
    expect(payload).toEqual({
      id: 'call-77',
      tool: 'analysis_workbench',
      phase: 'failed',
      timestamp: new Date(1_700_000_002_000).toISOString(),
    });
  });

  it('does not leak extra fields when the source object carries them', () => {
    const rich = {
      toolCallId: 'call-78',
      toolName: 'shell',
      phase: 'completed' as const,
      timestampMs: 1_700_000_003_000,
      // adversarial extras a caller might accidentally pass along
      arguments: { command: SECRET_PARAM },
      errorMessage: SECRET_TRANSCRIPT,
      output: SECRET_THOUGHT,
    };
    const serialized = JSON.stringify(redactToolActivity(rich));
    expect(serialized).not.toContain(SECRET_PARAM);
    expect(serialized).not.toContain(SECRET_TRANSCRIPT);
    expect(serialized).not.toContain(SECRET_THOUGHT);
  });
});

describe('redactArtifactCreated', () => {
  it('emits only the whitelisted keys and never a filesystem path', () => {
    const rich = {
      artifactId: 'art-1',
      label: 'sunset-render.png',
      mediaType: 'image/png',
      provenance: 'image_generation',
      createdAtMs: 1_700_000_004_000,
      previewable: true,
      // adversarial extras that must not survive
      localPath: SECRET_PATH,
      url: `https://internal.example/${SECRET_PARAM}`,
      dataBase64: SECRET_THOUGHT,
    };
    const payload = redactArtifactCreated(rich);
    expect(Object.keys(payload).sort()).toEqual(
      ['createdAt', 'id', 'label', 'mediaType', 'previewable', 'provenance'].sort(),
    );
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain(SECRET_PATH);
    expect(serialized).not.toContain(SECRET_PARAM);
    expect(serialized).not.toContain(SECRET_THOUGHT);
    expect(payload.previewable).toBe(true);
  });

  it('coerces previewable to a strict boolean and defaults blank fields', () => {
    const payload = redactArtifactCreated({
      artifactId: 'art-2',
      label: '   ',
      mediaType: '',
      provenance: '',
      createdAtMs: 1_700_000_005_000,
      previewable: 1 as unknown as boolean,
    });
    expect(payload.label).toBe('artifact');
    expect(payload.mediaType).toBe('application/octet-stream');
    expect(payload.provenance).toBe('unknown');
    expect(payload.previewable).toBe(false);
  });
});
