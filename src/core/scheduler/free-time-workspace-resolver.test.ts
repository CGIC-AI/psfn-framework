import { describe, expect, it } from 'vitest';
import type { ContextEnvelope } from '../../system/trust/context-envelope.js';
import {
  freeTimeWorkspaceContextFromVisibility,
  FreeTimeWorkspaceResolver,
  resolveFreeTimeWorkspace,
  type FreeTimeProjectRecord,
  type FreeTimeWorkspaceResolverDeps,
  type ResolvedRoomChannel,
} from './free-time-workspace-resolver.js';

const INVITE_ENVELOPE: ContextEnvelope = {
  channelPrivacy: 'invite_only',
  audienceScope: 'group',
  audienceKnowledge: 'all_known',
  broadcast: false,
};

const PUBLIC_ENVELOPE: ContextEnvelope = {
  channelPrivacy: 'public',
  audienceScope: 'group',
  audienceKnowledge: 'anonymous',
  broadcast: true,
};

const PRIVATE_ENVELOPE: ContextEnvelope = {
  channelPrivacy: 'private',
  audienceScope: 'one',
  audienceKnowledge: 'all_known',
  broadcast: false,
};

function makeDeps(overrides: Partial<FreeTimeWorkspaceResolverDeps> = {}): FreeTimeWorkspaceResolverDeps {
  return {
    projectDirectory: () => null,
    roomChannelResolver: () => null,
    ...overrides,
  };
}

function projectDirectoryOf(records: Record<string, FreeTimeProjectRecord>): FreeTimeWorkspaceResolverDeps['projectDirectory'] {
  return (ref: string) => records[ref] ?? null;
}

function roomResolverOf(channels: Record<string, ResolvedRoomChannel>): FreeTimeWorkspaceResolverDeps['roomChannelResolver'] {
  return (channelId: string) => channels[channelId] ?? null;
}

describe('resolveFreeTimeWorkspace — private wandering (§10.4/§10.6)', () => {
  it('resolves the single continuous private session, broad ceiling, private-self return', () => {
    const workspace = resolveFreeTimeWorkspace({ kind: 'private_wander' }, makeDeps());

    expect(workspace.sessionId).toBe('internal:free-time:private');
    expect(workspace.projectRef).toBeUndefined();
    expect(workspace.workContext).toEqual({ kind: 'private' });
    expect(workspace.retrievalPolicy).toEqual({
      retrievalCeiling: 'confidential',
      disclosureCeiling: { kind: 'companion_self' },
      allowBroadSelfRetrieval: true,
    });
    expect(workspace.returnPolicy).toEqual({ kind: 'private_self' });
  });

  it('carries a DM return target without widening the disclosure ceiling', () => {
    const workspace = resolveFreeTimeWorkspace(
      { kind: 'private_wander', returnTarget: { contactId: 'contact-abc' } },
      makeDeps(),
    );

    expect(workspace.workContext).toEqual({ kind: 'private', returnTarget: { contactId: 'contact-abc' } });
    // The return target limits the return projection, NOT what may be created:
    // the disclosure ceiling stays companion-self (§10.6).
    expect(workspace.retrievalPolicy.disclosureCeiling).toEqual({ kind: 'companion_self' });
    expect(workspace.returnPolicy).toEqual({ kind: 'contact_dm', contactId: 'contact-abc' });
  });
});

describe('resolveFreeTimeWorkspace — private project (§10.4)', () => {
  it('resolves a stable project-specific internal session distinct from wandering', () => {
    const deps = makeDeps({
      projectDirectory: projectDirectoryOf({
        'project:moon-garden': { projectRef: 'project:moon-garden', workspace: { kind: 'private' } },
      }),
    });

    const workspace = resolveFreeTimeWorkspace({ kind: 'resume_project', projectRef: 'project:moon-garden' }, deps);

    expect(workspace.sessionId).toBe('internal:free-time:project:moon-garden');
    expect(workspace.projectRef).toBe('project:moon-garden');
    expect(workspace.workContext).toEqual({ kind: 'private' });
    expect(workspace.retrievalPolicy.allowBroadSelfRetrieval).toBe(true);
    expect(workspace.returnPolicy).toEqual({ kind: 'private_self' });
  });
});

describe('resolveFreeTimeWorkspace — room project (§10.7)', () => {
  it('binds the stable channel, inherits its envelope, and bounds retrieval to the room ceiling', () => {
    const deps = makeDeps({
      projectDirectory: projectDirectoryOf({
        'project:group-article': { projectRef: 'project:group-article', workspace: { kind: 'room', channelId: 'chan-1' } },
      }),
      roomChannelResolver: roomResolverOf({
        'chan-1': { envelope: INVITE_ENVELOPE, disclosureCeiling: 'personal' },
      }),
    });

    const workspace = resolveFreeTimeWorkspace({ kind: 'resume_project', projectRef: 'project:group-article' }, deps);

    expect(workspace.sessionId).toBe('internal:free-time:room:group-article');
    expect(workspace.workContext).toEqual({ kind: 'room', channelId: 'chan-1', envelope: INVITE_ENVELOPE });
    expect(workspace.retrievalPolicy).toEqual({
      retrievalCeiling: 'personal',
      disclosureCeiling: { kind: 'invite_only_room', channelId: 'chan-1' },
      allowBroadSelfRetrieval: false,
    });
    expect(workspace.returnPolicy).toEqual({ kind: 'room', channelId: 'chan-1' });
  });

  it('classifies a broadcast/public channel as a public room', () => {
    const deps = makeDeps({
      roomChannelResolver: roomResolverOf({ 'pub-1': { envelope: PUBLIC_ENVELOPE, disclosureCeiling: 'public' } }),
    });

    const workspace = resolveFreeTimeWorkspace(
      { kind: 'create_workspace', projectRef: 'project:townhall', workspace: { kind: 'room', channelId: 'pub-1' } },
      deps,
    );

    expect(workspace.retrievalPolicy.disclosureCeiling).toEqual({ kind: 'public_room', channelId: 'pub-1' });
    expect(workspace.retrievalPolicy.retrievalCeiling).toBe('public');
  });

  it('does not fork the session on a differing participant roster — session keys on the project id', () => {
    const deps = makeDeps({
      roomChannelResolver: roomResolverOf({ 'chan-1': { envelope: INVITE_ENVELOPE, disclosureCeiling: 'personal' } }),
    });

    const first = resolveFreeTimeWorkspace(
      { kind: 'create_workspace', projectRef: 'project:group-article', workspace: { kind: 'room', channelId: 'chan-1' } },
      deps,
    );
    const second = resolveFreeTimeWorkspace(
      { kind: 'create_workspace', projectRef: 'project:group-article', workspace: { kind: 'room', channelId: 'chan-1' } },
      deps,
    );

    expect(second.sessionId).toBe(first.sessionId);
  });

  it('fails closed on an unresolvable room channel — never guesses a destination', () => {
    const deps = makeDeps({
      projectDirectory: projectDirectoryOf({
        'project:ghost': { projectRef: 'project:ghost', workspace: { kind: 'room', channelId: 'missing' } },
      }),
    });

    expect(() => resolveFreeTimeWorkspace({ kind: 'resume_project', projectRef: 'project:ghost' }, deps))
      .toThrow(/could not resolve channel missing/);
  });

  it('fails closed on a room workspace bound to a private (non-room) channel', () => {
    const deps = makeDeps({
      roomChannelResolver: roomResolverOf({ 'dm-1': { envelope: PRIVATE_ENVELOPE, disclosureCeiling: 'intimate' } }),
    });

    expect(() => resolveFreeTimeWorkspace(
      { kind: 'create_workspace', projectRef: 'project:bad-room', workspace: { kind: 'room', channelId: 'dm-1' } },
      deps,
    )).toThrow(/non-room channel/);
  });

  it('fails closed on a blank room channel id', () => {
    expect(() => resolveFreeTimeWorkspace(
      { kind: 'create_workspace', projectRef: 'project:blank', workspace: { kind: 'room', channelId: '   ' } },
      makeDeps(),
    )).toThrow(/missing a channel id/);
  });
});

describe('resolveFreeTimeWorkspace — publication project (§10.9/§10.10)', () => {
  it('public-clean: public retrieval ceiling, publication disclosure ceiling, no broad self retrieval', () => {
    const workspace = resolveFreeTimeWorkspace(
      {
        kind: 'create_workspace',
        projectRef: 'project:ai-essay',
        workspace: { kind: 'publication', mode: 'public_clean', surfaceRef: 'blog:draft-1' },
      },
      makeDeps(),
    );

    expect(workspace.sessionId).toBe('internal:free-time:publication:public_clean:ai-essay');
    expect(workspace.workContext).toEqual({ kind: 'publication', mode: 'public_clean', surfaceRef: 'blog:draft-1' });
    expect(workspace.retrievalPolicy).toEqual({
      retrievalCeiling: 'public',
      disclosureCeiling: { kind: 'publication' },
      allowBroadSelfRetrieval: false,
    });
    expect(workspace.returnPolicy).toEqual({ kind: 'publication_state', projectRef: 'project:ai-essay', mode: 'public_clean' });
  });

  it('expressive-review: broad private retrieval but companion-self disclosure ceiling (no autonomous egress)', () => {
    const deps = makeDeps({
      projectDirectory: projectDirectoryOf({
        'project:memoir': { projectRef: 'project:memoir', workspace: { kind: 'publication', mode: 'expressive_review' } },
      }),
    });

    const workspace = resolveFreeTimeWorkspace({ kind: 'resume_project', projectRef: 'project:memoir' }, deps);

    expect(workspace.sessionId).toBe('internal:free-time:publication:expressive_review:memoir');
    expect(workspace.workContext).toEqual({ kind: 'publication', mode: 'expressive_review' });
    expect(workspace.retrievalPolicy).toEqual({
      retrievalCeiling: 'confidential',
      disclosureCeiling: { kind: 'companion_self' },
      allowBroadSelfRetrieval: true,
    });
    expect(workspace.returnPolicy).toEqual({ kind: 'publication_state', projectRef: 'project:memoir', mode: 'expressive_review' });
  });
});

describe('resolveFreeTimeWorkspace — fail-closed + continuity invariants', () => {
  it('every resolved continuity session is an internal, non-egressing partition', () => {
    const deps = makeDeps({
      roomChannelResolver: roomResolverOf({ 'chan-1': { envelope: INVITE_ENVELOPE, disclosureCeiling: 'personal' } }),
    });
    const sessions = [
      resolveFreeTimeWorkspace({ kind: 'private_wander' }, deps).sessionId,
      resolveFreeTimeWorkspace(
        { kind: 'create_workspace', projectRef: 'project:p', workspace: { kind: 'private' } },
        deps,
      ).sessionId,
      resolveFreeTimeWorkspace(
        { kind: 'create_workspace', projectRef: 'project:r', workspace: { kind: 'room', channelId: 'chan-1' } },
        deps,
      ).sessionId,
      resolveFreeTimeWorkspace(
        { kind: 'create_workspace', projectRef: 'project:pub', workspace: { kind: 'publication', mode: 'public_clean' } },
        deps,
      ).sessionId,
    ];
    for (const sessionId of sessions) {
      expect(sessionId.startsWith('internal:free-time:')).toBe(true);
    }
  });

  it('fails closed on an unknown resume target', () => {
    expect(() => resolveFreeTimeWorkspace({ kind: 'resume_project', projectRef: 'project:nope' }, makeDeps()))
      .toThrow(/not a known project/);
  });

  it('fails closed on a malformed project ref', () => {
    expect(() => resolveFreeTimeWorkspace(
      { kind: 'create_workspace', projectRef: 'project:Bad Ref!', workspace: { kind: 'private' } },
      makeDeps(),
    )).toThrow();
  });

  it('rejects traversal and foreign internal prefixes in session-key segments', () => {
    for (const projectRef of ['project:../escape', 'project:internal:reflection:foreign']) {
      expect(() => resolveFreeTimeWorkspace(
        { kind: 'create_workspace', projectRef, workspace: { kind: 'private' } },
        makeDeps(),
      )).toThrow(/project ref/u);
    }
  });
});

describe('FreeTimeWorkspaceResolver (§13.2 resolve half)', () => {
  it('exposes an async resolve equivalent to the pure function', async () => {
    const deps = makeDeps();
    const resolver = new FreeTimeWorkspaceResolver(deps);
    await expect(resolver.resolve({ kind: 'private_wander' })).resolves.toEqual(
      resolveFreeTimeWorkspace({ kind: 'private_wander' }, deps),
    );
  });
});

describe('freeTimeWorkspaceContextFromVisibility (jp36.2.2.2 enum mapping, S11.4)', () => {
  it('maps self to a private companion-self context with no return target', () => {
    expect(freeTimeWorkspaceContextFromVisibility('self')).toEqual({ kind: 'private' });
    expect(freeTimeWorkspaceContextFromVisibility('self', { primaryContactId: 'contact:partner' }))
      .toEqual({ kind: 'private' });
  });

  it('maps primary_contact to a private, partner-anchored context when the partner id is known', () => {
    expect(freeTimeWorkspaceContextFromVisibility('primary_contact', { primaryContactId: 'contact:partner' }))
      .toEqual({ kind: 'private', returnTarget: { contactId: 'contact:partner' } });
  });

  it('fails open to private (never broadens) when primary_contact has no resolved partner id', () => {
    expect(freeTimeWorkspaceContextFromVisibility('primary_contact')).toEqual({ kind: 'private' });
    expect(freeTimeWorkspaceContextFromVisibility('primary_contact', { primaryContactId: '   ' }))
      .toEqual({ kind: 'private' });
  });

  it('maps public to a public-clean publication context', () => {
    expect(freeTimeWorkspaceContextFromVisibility('public'))
      .toEqual({ kind: 'publication', mode: 'public_clean' });
  });

  it('fails closed on an unknown visibility rather than guessing a work context', () => {
    expect(() => freeTimeWorkspaceContextFromVisibility('broadcast' as never))
      .toThrow(/unknown companion-owned visibility/);
  });

  it('preserves partner return eligibility end-to-end through the resolver (acceptance)', () => {
    // A primary_contact project resolved through the real resolver must yield a
    // contact_dm return policy targeting the partner — the partner still
    // receives eligible return context post-migration (§10.6/§10.8).
    const partnerId = 'contact:partner';
    const record: FreeTimeProjectRecord = {
      projectRef: 'project:moon-garden',
      workspace: freeTimeWorkspaceContextFromVisibility('primary_contact', { primaryContactId: partnerId }),
    };
    const deps = makeDeps({ projectDirectory: () => record });
    const resolved = resolveFreeTimeWorkspace(
      { kind: 'resume_project', projectRef: 'project:moon-garden' },
      deps,
    );
    expect(resolved.workContext).toEqual({ kind: 'private', returnTarget: { contactId: partnerId } });
    expect(resolved.returnPolicy).toEqual({ kind: 'contact_dm', contactId: partnerId });
    expect(resolved.retrievalPolicy.disclosureCeiling).toEqual({ kind: 'companion_self' });
  });
});
