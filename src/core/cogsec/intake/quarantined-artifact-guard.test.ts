// hrmrq.54 — quarantined-artifact access guard tests.
//
// Regression for the S11 shakedown containment bypass: quarantine held the
// document, but fs.read of the saved/parsed paths served the raw content into
// the turn with no operator-visible trace.

import {
  linkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createIntakeEnvelope,
  transitionIntakeEnvelope,
  type IntakeEnvelope,
} from '../../../shared/contracts/intake-envelope.js';
import { INTAKE_FIREWALL_NOTICE_TEMPLATES } from '../intake-firewall-notice-templates.js';
import {
  createIntakeQuarantineStore,
  type IntakeQuarantineStore,
} from './quarantine-store.js';
import {
  createQuarantinedArtifactAccessGuard,
  createUnionQuarantinedArtifactAccessGuard,
} from './quarantined-artifact-guard.js';

const NOW = 1_750_000_000_000;

function makeQuarantinedEnvelope(id?: string): IntakeEnvelope {
  const sha256 = 'b'.repeat(64);
  let envelope = createIntakeEnvelope({
    sourceClass: 'document',
    sourceRiskTier: 'untrusted',
    contentRef: { store: 'intake-quarantine', ref: `sha256:${sha256}`, sha256 },
    origin: { ref: 'api:chan-1:msg-1:evil.md' },
    ...(id !== undefined ? { id } : {}),
    atMs: NOW,
  });
  envelope = transitionIntakeEnvelope(envelope, {
    to: 'screened',
    actor: 'test:screening',
    reason: 'l1:injection/override_attempt',
    atMs: NOW,
    decision: {
      action: 'quarantine',
      reason: 'l1:injection/override_attempt',
      decidedBy: 'screening',
      decidedAtMs: NOW,
    },
    riskLabels: ['injection/override_attempt'],
    scores: { 'l1-rule-engine': 1 },
    extractedFields: {},
  });
  return transitionIntakeEnvelope(envelope, {
    to: 'quarantined',
    actor: 'test:screening',
    reason: "routed per screening decision 'quarantine'",
    atMs: NOW,
  });
}

describe('quarantined-artifact access guard (hrmrq.54)', () => {
  let dir: string;
  let store: IntakeQuarantineStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'quarantined-artifact-guard-'));
    store = createIntakeQuarantineStore(join(dir, 'intake-quarantine.json'), {
      itemTtlHours: 168,
      maxHeldItems: 100,
      now: () => NOW,
    });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('withholds enforce-mode reads of a held artifact and records the attempt', () => {
    const envelope = makeQuarantinedEnvelope();
    store.hold({
      envelope,
      mode: 'enforce',
      rawText: 'MARKER-a6932606e2a7',
      artifactPaths: ['/companion/files/doc.md', '/companion/files/doc.md.parsed.txt'],
    });
    const guard = createQuarantinedArtifactAccessGuard({ store, mode: 'enforce', now: () => NOW });

    const verdict = guard.check('/companion/files/doc.md.parsed.txt', { via: 'gateway:fs.read' });
    expect(verdict.withheld).toBe(true);
    if (verdict.withheld) {
      expect(verdict.envelopeId).toBe(envelope.id);
      expect(verdict.noticeText).toBe(INTAKE_FIREWALL_NOTICE_TEMPLATES.withheldContent);
      expect(verdict.noticeText).not.toContain('MARKER');
    }

    const entry = store.getById(envelope.id);
    expect(entry?.accessAttempts).toEqual([
      { path: '/companion/files/doc.md.parsed.txt', via: 'gateway:fs.read', atMs: NOW },
    ]);
  });

  it('does not withhold unregistered paths', () => {
    const guard = createQuarantinedArtifactAccessGuard({ store, mode: 'enforce' });
    expect(guard.check('/companion/files/innocent.txt', { via: 'gateway:fs.read' }))
      .toEqual({ withheld: false });
  });

  it('withholds hardlink aliases and verdicts bound to an opened held inode', () => {
    const heldPath = join(dir, 'held-identity.md');
    const hardlinkPath = join(dir, 'held-hardlink.md');
    const safePath = join(dir, 'currently-safe.md');
    writeFileSync(heldPath, 'MARKER-physical-identity');
    linkSync(heldPath, hardlinkPath);
    writeFileSync(safePath, 'ordinary content');
    const envelope = makeQuarantinedEnvelope();
    store.hold({
      envelope,
      mode: 'enforce',
      rawText: 'MARKER-physical-identity',
      artifactPaths: [heldPath],
    });
    const heldStats = statSync(heldPath, { bigint: true });
    const heldIdentity = `${heldStats.dev.toString()}:${heldStats.ino.toString()}`
      + `:${heldStats.birthtimeNs.toString()}`;
    expect(store.getById(envelope.id)?.artifactIdentities).toEqual([heldIdentity]);

    // Pre-upgrade records have no persisted identity. Reload must derive it
    // from the registered reachable path rather than silently losing alias
    // protection after deployment.
    const storePath = join(dir, 'intake-quarantine.json');
    const legacy = JSON.parse(readFileSync(storePath, 'utf8')) as {
      entries: Array<{ artifactIdentities?: string[] }>;
    };
    delete legacy.entries[0]?.artifactIdentities;
    writeFileSync(storePath, `${JSON.stringify(legacy)}\n`, 'utf8');

    const guard = createQuarantinedArtifactAccessGuard({ store, mode: 'enforce' });
    expect(guard.check(hardlinkPath, { via: 'gateway:fs.read' }))
      .toMatchObject({ withheld: true, envelopeId: envelope.id });

    expect(guard.checkMany(
      [safePath],
      { via: 'gateway:fs.search' },
      { physicalIdentities: [heldIdentity] },
    ).verdicts).toEqual([
      expect.objectContaining({ withheld: true, envelopeId: envelope.id }),
    ]);
  });

  it('allows reads after an operator release (sink-consumable envelope state)', () => {
    const envelope = makeQuarantinedEnvelope();
    store.hold({
      envelope,
      mode: 'enforce',
      rawText: 'held',
      artifactPaths: ['/companion/files/released.md'],
    });
    store.applyDecision({
      id: envelope.id,
      action: 'release_raw',
      actor: 'operator:garden',
      reason: 'reviewed, safe',
      atMs: NOW,
    });
    const guard = createQuarantinedArtifactAccessGuard({ store, mode: 'enforce' });
    expect(guard.check('/companion/files/released.md', { via: 'gateway:fs.read' }))
      .toEqual({ withheld: false });
  });

  it('keeps withholding after a discard decision (content stays operator-scrubbed)', () => {
    const envelope = makeQuarantinedEnvelope();
    store.hold({
      envelope,
      mode: 'enforce',
      rawText: 'held',
      artifactPaths: ['/companion/files/discarded.md'],
    });
    store.applyDecision({
      id: envelope.id,
      action: 'discard',
      actor: 'operator:garden',
      reason: 'hostile',
      atMs: NOW,
    });
    const guard = createQuarantinedArtifactAccessGuard({ store, mode: 'enforce' });
    const verdict = guard.check('/companion/files/discarded.md', { via: 'gateway:fs.read' });
    expect(verdict.withheld).toBe(true);
  });

  it('shadow mode records the attempt but never withholds (observe-only)', () => {
    const envelope = makeQuarantinedEnvelope();
    store.hold({
      envelope,
      mode: 'shadow',
      rawText: 'held',
      artifactPaths: ['/companion/files/shadow.md'],
    });
    const guard = createQuarantinedArtifactAccessGuard({ store, mode: 'shadow', now: () => NOW });
    expect(guard.check('/companion/files/shadow.md', { via: 'gateway:fs.read' }))
      .toEqual({ withheld: false });
    expect(store.getById(envelope.id)?.accessAttempts).toHaveLength(1);
  });

  it('fails closed in enforce mode when the store lookup throws', () => {
    const guard = createQuarantinedArtifactAccessGuard({
      store: {
        findByArtifactPath: () => {
          throw new Error('corrupt quarantine file');
        },
        findByArtifactPaths: () => {
          throw new Error('corrupt quarantine file');
        },
        recordAccessAttempt: () => {
          throw new Error('unreachable');
        },
        recordAccessAttempts: () => {
          throw new Error('unreachable');
        },
        checkArtifactAccesses: () => {
          throw new Error('corrupt quarantine file');
        },
        readRevisionToken: () => 'broken',
        listActiveArtifactPaths: () => {
          throw new Error('corrupt quarantine file');
        },
        listActiveArtifactIdentities: () => {
          throw new Error('corrupt quarantine file');
        },
      },
      mode: 'enforce',
    });
    expect(() => guard.check('/companion/files/doc.md', { via: 'gateway:fs.read' }))
      .toThrow(/failed to resolve or audit.*corrupt quarantine file/iu);
  });

  it('fails the access closed when the attempt audit write fails', () => {
    const envelope = makeQuarantinedEnvelope();
    store.hold({
      envelope,
      mode: 'enforce',
      rawText: 'held',
      artifactPaths: ['/companion/files/audit-broken.md'],
    });
    const guard = createQuarantinedArtifactAccessGuard({
      store: {
        findByArtifactPath: (path) => store.findByArtifactPath(path),
        findByArtifactPaths: (paths) => store.findByArtifactPaths(paths),
        recordAccessAttempt: () => {
          throw new Error('disk full');
        },
        recordAccessAttempts: () => {
          throw new Error('disk full');
        },
        checkArtifactAccesses: () => {
          throw new Error('disk full');
        },
        readRevisionToken: () => store.readRevisionToken(),
        listActiveArtifactPaths: () => store.listActiveArtifactPaths(),
        listActiveArtifactIdentities: () => store.listActiveArtifactIdentities(),
      },
      mode: 'enforce',
    });
    expect(() => guard.check('/companion/files/audit-broken.md', { via: 'gateway:fs.read' }))
      .toThrow(/failed to resolve or audit.*disk full/iu);
  });

  it('aborts shadow-mode access when the attempt cannot be audited', () => {
    const envelope = makeQuarantinedEnvelope();
    store.hold({
      envelope,
      mode: 'shadow',
      rawText: 'held',
      artifactPaths: ['/companion/files/shadow-audit-broken.md'],
    });
    const guard = createQuarantinedArtifactAccessGuard({
      store: {
        findByArtifactPath: (path) => store.findByArtifactPath(path),
        findByArtifactPaths: (paths) => store.findByArtifactPaths(paths),
        recordAccessAttempt: () => {
          throw new Error('disk full');
        },
        recordAccessAttempts: () => {
          throw new Error('disk full');
        },
        checkArtifactAccesses: () => {
          throw new Error('disk full');
        },
        readRevisionToken: () => store.readRevisionToken(),
        listActiveArtifactPaths: () => store.listActiveArtifactPaths(),
        listActiveArtifactIdentities: () => store.listActiveArtifactIdentities(),
      },
      mode: 'shadow',
    });

    expect(() => guard.check('/companion/files/shadow-audit-broken.md', {
      via: 'gateway:fs.read',
    })).toThrow(/failed to resolve or audit.*disk full/iu);
  });

  it('fails closed when canonicalizing a requested artifact path fails unexpectedly', () => {
    const loopPath = join(dir, 'symlink-loop');
    symlinkSync(loopPath, loopPath);
    const guard = createQuarantinedArtifactAccessGuard({ store, mode: 'enforce' });

    expect(guard.check(loopPath, { via: 'gateway:fs.read' }))
      .toMatchObject({ withheld: true, envelopeId: 'unknown' });
  });

  it('batch-checks and audits resolvable held paths independently of a canonicalization failure', () => {
    const heldPath = join(dir, 'held.md');
    const loopPath = join(dir, 'batch-symlink-loop');
    symlinkSync(loopPath, loopPath);
    const envelope = makeQuarantinedEnvelope();
    store.hold({
      envelope,
      mode: 'enforce',
      rawText: 'MARKER-content',
      artifactPaths: [heldPath],
    });
    const guard = createQuarantinedArtifactAccessGuard({ store, mode: 'enforce', now: () => NOW });

    expect(guard.checkMany([heldPath, loopPath], { via: 'gateway:fs.search' }).verdicts)
      .toEqual([
        expect.objectContaining({ withheld: true, envelopeId: envelope.id }),
        expect.objectContaining({ withheld: true, envelopeId: 'unknown' }),
      ]);
    expect(store.getById(envelope.id)?.accessAttempts).toEqual([
      { path: heldPath, via: 'gateway:fs.search', atMs: NOW },
    ]);
  });

  it('fails the fleet union closed when any companion store is unreadable', () => {
    const brokenStore = {
      findByArtifactPath: () => {
        throw new Error('companion B quarantine is corrupt');
      },
      findByArtifactPaths: () => {
        throw new Error('companion B quarantine is corrupt');
      },
      recordAccessAttempt: () => {
        throw new Error('unreachable');
      },
      recordAccessAttempts: () => {
        throw new Error('unreachable');
      },
      checkArtifactAccesses: () => {
        throw new Error('companion B quarantine is corrupt');
      },
      readRevisionToken: () => 'broken',
      listActiveArtifactPaths: () => {
        throw new Error('companion B quarantine is corrupt');
      },
      listActiveArtifactIdentities: () => {
        throw new Error('companion B quarantine is corrupt');
      },
    };
    const guard = createUnionQuarantinedArtifactAccessGuard({
      stores: [store, brokenStore],
      mode: 'enforce',
    });

    expect(() => guard.check('/companion-b/files/unknown.md', { via: 'gateway:fs.read' }))
      .toThrow(/failed to resolve or audit.*companion B quarantine is corrupt/iu);
    expect(() => guard.listEnforcedArtifactPaths())
      .toThrow('companion B quarantine is corrupt');
  });

  describe('listEnforcedArtifactPaths (shell physical deny set)', () => {
    it('enforce mode returns the registered paths of not-released entries', () => {
      const held = makeQuarantinedEnvelope();
      store.hold({
        envelope: held,
        mode: 'enforce',
        rawText: 'held',
        artifactPaths: ['/companion/files/doc.md', '/companion/files/doc.md.parsed.txt'],
      });
      const released = makeQuarantinedEnvelope();
      store.hold({
        envelope: released,
        mode: 'enforce',
        rawText: 'released',
        artifactPaths: ['/companion/files/cleared.md'],
      });
      store.applyDecision({
        id: released.id,
        action: 'release_raw',
        actor: 'operator:garden',
        reason: 'reviewed, safe',
        atMs: NOW,
      });

      const guard = createQuarantinedArtifactAccessGuard({ store, mode: 'enforce', now: () => NOW });
      const paths = guard.listEnforcedArtifactPaths();
      expect(paths).toContain('/companion/files/doc.md');
      expect(paths).toContain('/companion/files/doc.md.parsed.txt');
      expect(paths).not.toContain('/companion/files/cleared.md');
    });

    it('shadow mode returns an empty deny set (observe-only, nothing physically denied)', () => {
      store.hold({
        envelope: makeQuarantinedEnvelope(),
        mode: 'shadow',
        rawText: 'held',
        artifactPaths: ['/companion/files/shadow.md'],
      });
      const guard = createQuarantinedArtifactAccessGuard({ store, mode: 'shadow', now: () => NOW });
      expect(guard.listEnforcedArtifactPaths()).toEqual([]);
    });

    it('enforce mode propagates store failures (an unenumerable deny set fails the launch)', () => {
      const guard = createQuarantinedArtifactAccessGuard({
        store: {
          findByArtifactPath: () => undefined,
          findByArtifactPaths: () => new Map(),
          recordAccessAttempt: () => {
            throw new Error('unreachable');
          },
          recordAccessAttempts: () => {
            throw new Error('unreachable');
          },
          checkArtifactAccesses: () => ({ entries: [], revisionToken: 'broken' }),
          readRevisionToken: () => 'broken',
          listActiveArtifactPaths: () => {
            throw new Error('corrupt quarantine file');
          },
          listActiveArtifactIdentities: () => {
            throw new Error('corrupt quarantine file');
          },
        },
        mode: 'enforce',
      });
      expect(() => guard.listEnforcedArtifactPaths()).toThrow('corrupt quarantine file');
    });
  });
});
