import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentToolResult } from '../../boundary/pi-agent/index.js';
import type { TextContent } from '@earendil-works/pi-ai';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isRecord } from '../../shared/utils/types.js';
import { PersonalProjectLibrary } from './personal-projects.js';
import { PersonalWishlist } from './personal-wishlist.js';
import { createProjectsTool } from './projects-tool.js';
import { WikiStore } from './store.js';

function resultText(result: AgentToolResult<any>): string {
  return result.content
    .filter((content): content is TextContent => content.type === 'text')
    .map(content => content.text)
    .join('');
}

describe('projects tool (wishes, personal projects, wardrobe)', () => {
  let tempDir: string;
  let store: WikiStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'projects-tool-'));
    store = new WikiStore(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('manages resumable projects and named looks', async () => {
    const personalProjects = new PersonalProjectLibrary(store);
    const tool = createProjectsTool({ personalProjects });

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

  it('fails closed when project or wish storage is unwired', async () => {
    const tool = createProjectsTool({});
    const projectResult = await tool.execute('project-list', { action: 'project_list' });
    expect(resultText(projectResult)).toContain('personal project storage is unavailable');
    expect(projectResult.details?.isError).toBe(true);

    const wishResult = await tool.execute('wish-list', { action: 'wish_list' });
    expect(resultText(wishResult)).toContain('personal wishlist storage is unavailable');
    expect(wishResult.details?.isError).toBe(true);
  });

  it('round-trips a companion wish through the projects tool and operator library', async () => {
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
    const tool = createProjectsTool({ personalWishlist });

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

  it('rejects model-supplied sensitivity/audience for project_add_artifact and derives lineage at runtime', async () => {
    const personalProjects = new PersonalProjectLibrary(store);
    const tool = createProjectsTool({ personalProjects });

    await tool.execute('project-create', {
      action: 'project_create',
      project_id: 'moon-garden',
      title: 'Moon Garden',
      next_step: 'Paint the second panel.',
      visibility: 'self',
    });

    const rejectedSensitivity = await tool.execute('add-artifact', {
      action: 'project_add_artifact',
      project_ref: 'project:moon-garden',
      artifact_ref: 'generated-image:panel-1',
      artifact_label: 'First panel',
      sensitivity: 'public',
    });
    expect(rejectedSensitivity.details?.isError).toBe(true);
    expect(resultText(rejectedSensitivity)).toContain('sensitivity is runtime-derived');
    expect(personalProjects.getProject('project:moon-garden').artifacts).toHaveLength(0);

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

  it('quarantines a project_add_artifact against later legacy-forged egress broadening', async () => {
    const personalProjects = new PersonalProjectLibrary(store);
    const tool = createProjectsTool({ personalProjects });

    await tool.execute('project-create', {
      action: 'project_create',
      project_id: 'quarantine-check',
      title: 'Quarantine Check',
      next_step: 'add art',
      visibility: 'self',
    });
    await tool.execute('add-artifact', {
      action: 'project_add_artifact',
      project_ref: 'project:quarantine-check',
      artifact_ref: 'generated-image:panel',
      artifact_label: 'Panel',
    });

    const shared = JSON.parse(resultText(await tool.execute('project-share', {
      action: 'project_share',
      project_ref: 'project:quarantine-check',
      artifact_ref: 'generated-image:panel',
      audience: 'primary_contact',
    }))) as { project: { artifacts: Array<Record<string, unknown>> } };
    expect(shared.project.artifacts[0]).toMatchObject({
      metadataLineage: 'runtime_derived',
      intendedAudience: 'primary_contact',
      shareState: 'requested',
    });
  });
});
