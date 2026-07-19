import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentToolResult } from '../../boundary/pi-agent/index.js';
import type { TextContent } from '@mariozechner/pi-ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WikiStore } from './store.js';
import { createWikiTool } from './tools.js';
import { isRecord } from '../../shared/utils/types.js';
import type {
  SharedWorldWikiProposalInput,
  SharedWorldWikiProposalSubmissionResult,
} from './shared-world-caretaker-types.js';
import { PersonalProjectLibrary } from './personal-projects.js';
import { PersonalWishlist } from './personal-wishlist.js';

function resultText(result: AgentToolResult<any>): string {
  return result.content
    .filter((content): content is TextContent => content.type === 'text')
    .map(content => content.text)
    .join('');
}

describe('wiki tool', () => {
  let tempDir: string;
  let store: WikiStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'wiki-tool-'));
    store = new WikiStore(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('writes, reads, searches, and lists internal wiki documents with boundary labels', async () => {
    const tool = createWikiTool(store);

    const written = JSON.parse(resultText(await tool.execute('write', {
      action: 'write',
      title: 'Garden Knowledge Surface',
      body: 'Garden should show wiki knowledge separately from memory.',
      tags: ['garden', 'wiki'],
    }))) as {
      action: string;
      document: { id: string; title: string; sourceClass: string };
      boundary: string;
    };
    expect(written.action).toBe('write');
    expect(written.document).toMatchObject({
      id: 'garden-knowledge-surface',
      sourceClass: 'companion_authored_note',
    });
    expect(written.boundary).toContain('no L2 memory was created');

    const read = JSON.parse(resultText(await tool.execute('read', {
      action: 'read',
      id: written.document.id,
    }))) as { document: { body: string }; boundary: string };
    expect(read.document.body).toContain('separately from memory');
    expect(read.boundary).toContain('not transcript memory');

    const searched = JSON.parse(resultText(await tool.execute('search', {
      query: 'Garden',
    }))) as { count: number; boundary: string; matches: Array<{ id: string }> };
    expect(searched.count).toBe(1);
    expect(searched.matches[0]?.id).toBe(written.document.id);
    expect(searched.boundary).toContain('not lived memory');

    const listed = JSON.parse(resultText(await tool.execute('list', {}))) as {
      documents: Array<{ id: string }>;
      boundary: string;
    };
    expect(listed.documents.map(document => document.id)).toEqual([written.document.id]);
    expect(listed.boundary).toContain('separate from L0/L0.1/L2 memory');
  });

  it('fails closed when imports omit source provenance', async () => {
    const tool = createWikiTool(store);
    const failed = resultText(await tool.execute('import-missing-provenance', {
      action: 'import',
      title: 'Vault Import',
      body: 'External note body.',
      source_class: 'imported_partner_vault_note',
    }));

    expect(failed).toContain('requires at least one provenance ref');

    const imported = JSON.parse(resultText(await tool.execute('import', {
      action: 'import',
      title: 'Vault Import',
      body: 'External note body.',
      source_class: 'imported_partner_vault_note',
      provenance_refs: ['vault:partner:Vault Import.md'],
    }))) as { document: { sourceClass: string; provenanceRefs: string[] } };
    expect(imported.document.sourceClass).toBe('imported_partner_vault_note');
    expect(imported.document.provenanceRefs).toEqual(['vault:partner:Vault Import.md']);
  });

  it('manages resumable projects and named looks through the existing wiki tool', async () => {
    const personalProjects = new PersonalProjectLibrary(store);
    const tool = createWikiTool(store, { personalProjects });

    const projectResult: unknown = JSON.parse(resultText(await tool.execute('project-create', {
      action: 'project_create',
      project_id: 'story-panels',
      title: 'Story Panels',
      next_step: 'Render the opening scene.',
      visibility: 'self',
    })));
    if (!isRecord(projectResult) || !isRecord(projectResult.project)) {
      throw new Error('project_create returned malformed data');
    }
    expect(projectResult.project.ref).toBe('project:story-panels');

    const lookResult: unknown = JSON.parse(resultText(await tool.execute('look-save', {
      action: 'wardrobe_save',
      look_id: 'starlight-study',
      look_name: 'Starlight Study',
      look_prompt: 'navy cardigan with silver star embroidery',
      visibility: 'primary_contact',
    })));
    if (!isRecord(lookResult) || !isRecord(lookResult.look)) {
      throw new Error('wardrobe_save returned malformed data');
    }
    expect(lookResult.look.ref).toBe('wardrobe:starlight-study');
    expect(store.list().map(document => document.id)).toEqual([
      'wardrobe.look.starlight-study',
      'project.story-panels',
    ]);
  });

  it('fails closed when project actions are unwired', async () => {
    const tool = createWikiTool(store);
    const result = await tool.execute('project-list', { action: 'project_list' });
    expect(resultText(result)).toContain('personal project storage is unavailable');
    expect(result.details?.isError).toBe(true);
  });

  it('round-trips a companion wish through the canonical wiki tool and operator library', async () => {
    const timestamps = [
      new Date('2026-07-16T10:00:00.000Z'),
      new Date('2026-07-16T10:01:00.000Z'),
      new Date('2026-07-16T10:02:00.000Z'),
    ];
    const personalWishlist = new PersonalWishlist(
      store,
      () => timestamps.shift() ?? new Date('2026-07-16T10:03:00.000Z'),
      () => '22222222-2222-4222-8222-222222222222',
    );
    const tool = createWikiTool(store, { personalWishlist });

    const created: unknown = JSON.parse(resultText(await tool.execute('wish-create', {
      action: 'wish_create',
      wish_text: 'I would love a quiet afternoon for watercolor practice.',
      wish_context: 'The new landscape palette has been sitting unopened.',
    })));
    if (!isRecord(created) || !isRecord(created.wish) || typeof created.boundary !== 'string') {
      throw new Error('wish_create returned malformed data');
    }
    expect(created.wish.ref).toBe('wish:22222222-2222-4222-8222-222222222222');
    expect(created.wish.state).toBe('open');
    expect(created.boundary).toContain('No push notification or operator interruption');

    personalWishlist.respondToWish(
      'wish:22222222-2222-4222-8222-222222222222',
      'That sounds lovely. Let us protect Saturday afternoon.',
    );
    personalWishlist.planWish(
      'wish:22222222-2222-4222-8222-222222222222',
      'wishlist-watercolor',
    );

    const listed: unknown = JSON.parse(resultText(await tool.execute('wish-list', {
      action: 'wish_list',
    })));
    if (!isRecord(listed) || !Array.isArray(listed.wishes) || !isRecord(listed.wishes[0])) {
      throw new Error('wish_list returned malformed data');
    }
    expect(listed.wishes).toHaveLength(1);
    expect(listed.wishes[0]).toMatchObject({
      state: 'planned',
      beadId: 'wishlist-watercolor',
      operatorResponse: 'That sounds lovely. Let us protect Saturday afternoon.',
    });
    expect(store.list()).toHaveLength(1);
  });

  it('fails closed when wish actions are unwired', async () => {
    const tool = createWikiTool(store);
    const result = await tool.execute('wish-list', { action: 'wish_list' });
    expect(resultText(result)).toContain('personal wishlist storage is unavailable');
    expect(result.details?.isError).toBe(true);
  });

  it('queues a shared-world proposal through an enqueue-only dependency', async () => {
    const submit = vi.fn(async (
      input: SharedWorldWikiProposalInput,
    ): Promise<SharedWorldWikiProposalSubmissionResult> => ({
      proposal: {
        ...input,
        documentId: input.documentId ?? 'kitchen-toaster',
        tags: [...(input.tags ?? [])],
        provenanceRefs: [...input.provenanceRefs],
        sensitivity: 'public',
        contentDigest: 'digest',
        proposalId: '11111111-1111-4111-8111-111111111111',
        reviewState: 'pending',
        applyState: 'unreviewed',
        revision: 1,
        createdAtMs: 1,
        updatedAtMs: 1,
      },
      deduplicated: false,
    }));
    const tool = createWikiTool(store, {
      sharedWorldProposal: {
        actorId: 'companion-a',
        submitter: { submit },
      },
    });

    const result: unknown = JSON.parse(resultText(await tool.execute('proposal', {
      action: 'propose_shared_world',
      site_id: 'studio',
      id: 'kitchen-toaster',
      title: 'Kitchen toaster',
      body: 'A toaster is installed in the kitchen.',
      source_ref: 'world-observation:turn-7',
      provenance_refs: ['world-observation:sensor-4'],
      sensitivity: 'public',
    })));
    if (!isRecord(result)
      || !isRecord(result.proposal)
      || typeof result.proposal.reviewState !== 'string'
      || typeof result.boundary !== 'string') {
      throw new Error('wiki proposal tool result is malformed');
    }

    expect(submit).toHaveBeenCalledWith(expect.objectContaining({
      siteId: 'studio',
      actorId: 'companion-a',
      sensitivity: 'public',
    }));
    expect(result.proposal.reviewState).toBe('pending');
    expect(result.boundary).toContain('no shared-world document was written');
    expect(store.list()).toEqual([]);
  });

  it('rejects model-supplied sensitivity/audience for project_add_artifact and derives lineage at runtime', async () => {
    const personalProjects = new PersonalProjectLibrary(store);
    const tool = createWikiTool(store, { personalProjects });

    await tool.execute('project-create', {
      action: 'project_create',
      project_id: 'moon-garden',
      title: 'Moon Garden',
      next_step: 'Paint the second panel.',
      visibility: 'self',
    });

    // Regression: the model must not self-assert sensitivity (bible §6.2).
    const rejectedSensitivity = await tool.execute('add-artifact', {
      action: 'project_add_artifact',
      project_ref: 'project:moon-garden',
      artifact_ref: 'generated-image:panel-1',
      artifact_label: 'First panel',
      sensitivity: 'public',
    });
    expect(rejectedSensitivity.details?.isError).toBe(true);
    expect(resultText(rejectedSensitivity)).toContain('sensitivity is runtime-derived');
    // Nothing was written under the rejected call.
    expect(personalProjects.getProject('project:moon-garden').artifacts).toHaveLength(0);

    // Regression: the model must not self-assert permitted audience either.
    const rejectedAudience = await tool.execute('add-artifact', {
      action: 'project_add_artifact',
      project_ref: 'project:moon-garden',
      artifact_ref: 'generated-image:panel-1',
      artifact_label: 'First panel',
      audience: 'public',
    });
    expect(rejectedAudience.details?.isError).toBe(true);
    expect(resultText(rejectedAudience)).toContain('audience is runtime-derived');
    expect(personalProjects.getProject('project:moon-garden').artifacts).toHaveLength(0);

    // Runtime derivation: a clean call succeeds and carries project-derived
    // lineage (self visibility → intimate floor, audience fails closed to self).
    const added = JSON.parse(resultText(await tool.execute('add-artifact', {
      action: 'project_add_artifact',
      project_ref: 'project:moon-garden',
      artifact_ref: 'generated-image:panel-1',
      artifact_label: 'First panel',
    }))) as { action: string; project: { artifacts: Array<Record<string, unknown>> } };
    expect(added.action).toBe('project_add_artifact');
    expect(added.project.artifacts).toHaveLength(1);
    expect(added.project.artifacts[0]).toMatchObject({
      ref: 'generated-image:panel-1',
      sensitivity: 'intimate',
      intendedAudience: 'self',
      shareState: 'private',
    });
  });
});
