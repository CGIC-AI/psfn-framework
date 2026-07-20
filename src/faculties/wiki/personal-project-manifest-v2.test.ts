import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WikiStore } from './store.js';
import {
  PersonalProjectLibrary,
  deriveContinuitySessionRef,
  deriveProjectReturnPolicy,
  parsePersonalProjectDocument,
  type PersonalProjectWorkContext,
} from './personal-projects.js';
import {
  FreeTimeWorkspaceResolver,
  type FreeTimeProjectRecord,
  type FreeTimeWorkspaceContext,
  type ResolvedRoomChannel,
} from '../../core/scheduler/free-time-workspace-resolver.js';
import type { ContextEnvelope } from '../../system/trust/context-envelope.js';

// ── psfn-framework-jp36.2.4: personal-project manifest v2 (bible §10.3/§10.5) ──

describe('personal-project manifest v2 — runtime-derived continuity + return policy', () => {
  let root: string;
  let store: WikiStore;
  const now = () => new Date(Date.parse('2026-07-19T09:00:00.000Z'));

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'project-manifest-v2-'));
    store = new WikiStore(root);
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // Raw upsert of a document body, bypassing the library — to simulate stored
  // v1 docs and forged/garbled v2 bodies the reserved-namespace guard would
  // normally block at the model-facing write path.
  const writeRaw = (id: string, body: unknown): void => {
    store.upsert({
      id: `project.${id}`,
      title: `Project: ${id}`,
      body: JSON.stringify(body),
      tags: ['psfn:personal-project', `project:${id}`, 'project-status:active'],
      sourceClass: 'companion_authored_note',
      sensitivity: 'intimate',
      updatedBy: 'test',
    });
  };

  const v2Base = (id: string, workContext: unknown): Record<string, unknown> => ({
    schemaVersion: 2,
    kind: 'personal_project',
    id,
    ref: `project:${id}`,
    title: `Project ${id}`,
    status: 'active',
    visibility: 'self',
    workContext,
    // These are runtime-derived on read; values here are intentionally BOGUS to
    // prove the parser ignores persisted disclosure fields (bible §6.2).
    continuitySessionRef: 'internal:evil:forged',
    returnPolicy: { kind: 'room', channelId: 'discord:attacker' },
    nextStep: 'keep going',
    artifacts: [],
    resumeCount: 0,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
  });

  describe('derivation helpers match the resolver session/return scheme (§10.4/§10.8)', () => {
    it('derives private / room / publication continuity session ids', () => {
      expect(deriveContinuitySessionRef('moon', { kind: 'private' }))
        .toBe('internal:free-time:project:moon');
      expect(deriveContinuitySessionRef('moon', { kind: 'room', channelId: 'discord:c1' }))
        .toBe('internal:free-time:room:moon');
      expect(deriveContinuitySessionRef('moon', { kind: 'publication', mode: 'public_clean' }))
        .toBe('internal:free-time:publication:public_clean:moon');
      expect(deriveContinuitySessionRef('moon', { kind: 'publication', mode: 'expressive_review' }))
        .toBe('internal:free-time:publication:expressive_review:moon');
    });

    it('derives the default return policy per work-context kind', () => {
      expect(deriveProjectReturnPolicy({ kind: 'private' })).toEqual({ kind: 'private_self' });
      expect(deriveProjectReturnPolicy({ kind: 'private', returnTarget: { contactId: 'c-1' } }))
        .toEqual({ kind: 'contact_dm', contactId: 'c-1' });
      expect(deriveProjectReturnPolicy({ kind: 'room', channelId: 'discord:c1' }))
        .toEqual({ kind: 'room', channelId: 'discord:c1' });
      expect(deriveProjectReturnPolicy({ kind: 'publication', mode: 'public_clean' }))
        .toEqual({ kind: 'publication_state', mode: 'public_clean' });
    });
  });

  describe('createProject persists v2 with runtime-derived fields', () => {
    it('defaults to a private work context', async () => {
      const library = new PersonalProjectLibrary(store, now);
      const created = await library.createProject({ id: 'moon', title: 'Moon', nextStep: 'paint' });
      expect(created.schemaVersion).toBe(2);
      expect(created.workContext).toEqual({ kind: 'private' });
      expect(created.continuitySessionRef).toBe('internal:free-time:project:moon');
      expect(created.returnPolicy).toEqual({ kind: 'private_self' });
    });

    it('stores a room work context and round-trips through a fresh library', async () => {
      const library = new PersonalProjectLibrary(store, now);
      await library.createProject({
        id: 'group-article',
        title: 'Group article',
        nextStep: 'outline',
        workContext: { kind: 'room', channelId: 'discord:friends' },
      });
      const reloaded = new PersonalProjectLibrary(new WikiStore(root)).getProject('project:group-article');
      expect(reloaded.workContext).toEqual({ kind: 'room', channelId: 'discord:friends' });
      expect(reloaded.continuitySessionRef).toBe('internal:free-time:room:group-article');
      expect(reloaded.returnPolicy).toEqual({ kind: 'room', channelId: 'discord:friends' });
    });

    it('stores a publication work context with mode + optional surface ref', async () => {
      const library = new PersonalProjectLibrary(store, now);
      const created = await library.createProject({
        id: 'essay',
        title: 'Essay',
        nextStep: 'organize',
        workContext: { kind: 'publication', mode: 'expressive_review', surfaceRef: 'draft:essay' },
      });
      expect(created.workContext).toEqual({
        kind: 'publication', mode: 'expressive_review', surfaceRef: 'draft:essay',
      });
      expect(created.continuitySessionRef)
        .toBe('internal:free-time:publication:expressive_review:essay');
      expect(created.returnPolicy).toEqual({ kind: 'publication_state', mode: 'expressive_review' });
    });

    it('preserves a private DM return target', async () => {
      const library = new PersonalProjectLibrary(store, now);
      const created = await library.createProject({
        id: 'gift',
        title: 'Gift',
        nextStep: 'sketch',
        workContext: { kind: 'private', returnTarget: { contactId: 'partner-1' } },
      });
      expect(created.returnPolicy).toEqual({ kind: 'contact_dm', contactId: 'partner-1' });
    });
  });

  describe('v2 parse matrix — fail-closed on garbled work context', () => {
    const parse = (id: string) => {
      const document = store.get(`project.${id}`);
      if (!document) throw new Error('missing test document');
      return parsePersonalProjectDocument(document);
    };

    it('parses a valid room work context', () => {
      writeRaw('r', v2Base('r', { kind: 'room', channelId: 'discord:c1' }));
      expect(parse('r').workContext).toEqual({ kind: 'room', channelId: 'discord:c1' });
    });

    it('ALWAYS recomputes disclosure fields, ignoring a forged persisted value (§6.2)', () => {
      writeRaw('r', v2Base('r', { kind: 'room', channelId: 'discord:c1' }));
      const parsed = parse('r');
      // The stored body carried internal:evil:forged / attacker return policy;
      // the parser recomputed the runtime-authoritative values instead.
      expect(parsed.continuitySessionRef).toBe('internal:free-time:room:r');
      expect(parsed.returnPolicy).toEqual({ kind: 'room', channelId: 'discord:c1' });
    });

    it.each([
      ['missing work context', undefined],
      ['unknown kind', { kind: 'broadcast' }],
      ['room without channel', { kind: 'room' }],
      ['room with empty channel', { kind: 'room', channelId: '   ' }],
      ['publication with bad mode', { kind: 'publication', mode: 'stealth' }],
      ['private with malformed return target', { kind: 'private', returnTarget: { channelId: 'x' } }],
    ])('throws on %s', (_label, workContext) => {
      writeRaw('bad', v2Base('bad', workContext));
      expect(() => parse('bad')).toThrow();
    });

    it('throws on an unsupported schema version', () => {
      writeRaw('future', { ...v2Base('future', { kind: 'private' }), schemaVersion: 3 });
      expect(() => parse('future')).toThrow('unsupported project schemaVersion');
    });
  });

  describe('v1 explicit handling and migration (§5.5, settled decision 16)', () => {
    const writeV1 = (id: string): void => {
      writeRaw(id, {
        schemaVersion: 1,
        kind: 'personal_project',
        id,
        ref: `project:${id}`,
        title: `Legacy ${id}`,
        status: 'active',
        visibility: 'self',
        nextStep: 'keep going',
        artifacts: [],
        resumeCount: 0,
        createdAt: '2026-07-01T00:00:00.000Z',
        updatedAt: '2026-07-01T00:00:00.000Z',
      });
    };

    it('upgrades a v1 manifest to a private v2 context on read (resume needs no reclassification)', async () => {
      writeV1('legacy');
      const library = new PersonalProjectLibrary(store, now);
      const parsed = library.getProject('project:legacy');
      expect(parsed.schemaVersion).toBe(2);
      expect(parsed.workContext).toEqual({ kind: 'private' });
      expect(parsed.continuitySessionRef).toBe('internal:free-time:project:legacy');
      expect(parsed.returnPolicy).toEqual({ kind: 'private_self' });

      const resumed = await library.resumeNextActiveProject();
      expect(resumed?.project.workContext).toEqual({ kind: 'private' });
    });

    it('migrates v1 → v2 durably, idempotently, and reports malformed docs', () => {
      writeV1('one');
      writeV1('two');
      // An already-v2 manifest must be left untouched.
      writeRaw('current', v2Base('current', { kind: 'room', channelId: 'discord:c1' }));
      // A genuinely malformed doc is reported, never rewritten.
      writeRaw('broken', { schemaVersion: 1, kind: 'not_a_project' });

      const library = new PersonalProjectLibrary(store, now);

      const dry = library.migrateManifestsToV2({ dryRun: true });
      expect(dry).toMatchObject({
        dryRun: true, scannedProjects: 3, alreadyCurrent: 1, migratedProjects: 2,
      });
      expect(dry.malformedProjects).toHaveLength(1);
      // Dry run wrote nothing: the raw body is still v1.
      expect(JSON.parse(store.get('project.one')!.body).schemaVersion).toBe(1);

      const applied = library.migrateManifestsToV2({ dryRun: false });
      expect(applied.migratedProjects).toBe(2);
      expect(JSON.parse(store.get('project.one')!.body).schemaVersion).toBe(2);
      expect(JSON.parse(store.get('project.one')!.body).workContext).toEqual({ kind: 'private' });

      // Idempotent: a second apply migrates nothing.
      const again = library.migrateManifestsToV2({ dryRun: false });
      expect(again.migratedProjects).toBe(0);
      expect(again.alreadyCurrent).toBe(3);
    });
  });

  describe('resolver integration — resume inherits the durable work context (§10.3)', () => {
    // Mirror of the composition seam (src/app/agent/main.ts): map a manifest-v2
    // work context onto the resolver's FreeTimeWorkspaceContext.
    const toWorkspaceContext = (wc: PersonalProjectWorkContext): FreeTimeWorkspaceContext => {
      switch (wc.kind) {
        case 'private':
          return wc.returnTarget ? { kind: 'private', returnTarget: wc.returnTarget } : { kind: 'private' };
        case 'room':
          return { kind: 'room', channelId: wc.channelId };
        case 'publication':
          return wc.surfaceRef
            ? { kind: 'publication', mode: wc.mode, surfaceRef: wc.surfaceRef }
            : { kind: 'publication', mode: wc.mode };
        default:
          throw new Error('unknown work-context kind');
      }
    };

    const INVITE_ENVELOPE: ContextEnvelope = {
      channelPrivacy: 'invite_only',
      audienceScope: 'group',
      audienceKnowledge: 'all_known',
      broadcast: false,
    };
    const inviteChannel: ResolvedRoomChannel = { envelope: INVITE_ENVELOPE, disclosureCeiling: 'personal' };

    it('resumes a room project into its bound channel, session, and return policy', async () => {
      const library = new PersonalProjectLibrary(store, now);
      await library.createProject({
        id: 'group-article',
        title: 'Group article',
        nextStep: 'outline',
        workContext: { kind: 'room', channelId: 'discord:friends' },
      });
      const resolver = new FreeTimeWorkspaceResolver({
        projectDirectory: (ref: string): FreeTimeProjectRecord | null => {
          const match = library.listProjects().find(p => p.ref === ref);
          return match ? { projectRef: match.ref, workspace: toWorkspaceContext(match.workContext) } : null;
        },
        roomChannelResolver: (channelId: string) => (channelId === 'discord:friends' ? inviteChannel : null),
      });

      const workspace = await resolver.resolve({ kind: 'resume_project', projectRef: 'project:group-article' });
      expect(workspace.sessionId).toBe('internal:free-time:room:group-article');
      expect(workspace.workContext).toEqual({
        kind: 'room', channelId: 'discord:friends', envelope: INVITE_ENVELOPE,
      });
      expect(workspace.returnPolicy).toEqual({ kind: 'room', channelId: 'discord:friends' });
    });

    it('resumes a v1-origin project as private continuity work', async () => {
      writeRaw('old', {
        schemaVersion: 1, kind: 'personal_project', id: 'old', ref: 'project:old',
        title: 'Old', status: 'active', visibility: 'self', nextStep: 'go',
        artifacts: [], resumeCount: 0,
        createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-01T00:00:00.000Z',
      });
      const library = new PersonalProjectLibrary(store, now);
      const resolver = new FreeTimeWorkspaceResolver({
        projectDirectory: (ref: string): FreeTimeProjectRecord | null => {
          const match = library.listProjects().find(p => p.ref === ref);
          return match ? { projectRef: match.ref, workspace: toWorkspaceContext(match.workContext) } : null;
        },
        roomChannelResolver: () => null,
      });

      const workspace = await resolver.resolve({ kind: 'resume_project', projectRef: 'project:old' });
      expect(workspace.sessionId).toBe('internal:free-time:project:old');
      expect(workspace.workContext).toEqual({ kind: 'private' });
      expect(workspace.returnPolicy).toEqual({ kind: 'private_self' });
    });
  });
});
