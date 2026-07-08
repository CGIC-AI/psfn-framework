import { describe, expect, it } from 'vitest';
import {
  syncAllBeadsToGitHubProject,
  syncMutatedBeadToGitHubProject,
} from './beads-github-project-sync.js';

interface QueuedResponse {
  stdout?: string;
  error?: Error;
}

class FakeRunner {
  readonly calls: Array<{
    command: string;
    args: string[];
    cwd: string;
    label: string;
  }> = [];

  constructor(private readonly queue: QueuedResponse[]) {}

  async run(
    command: string,
    args: readonly string[],
    options: { cwd: string; label: string },
  ): Promise<string> {
    this.calls.push({
      command,
      args: [...args],
      cwd: options.cwd,
      label: options.label,
    });
    const next = this.queue.shift();
    if (!next) {
      throw new Error(`No queued response for ${options.label}`);
    }
    if (next.error) {
      throw next.error;
    }
    return next.stdout ?? '';
  }
}

describe('beads GitHub Project sync helper', () => {
  it('creates a draft project item for an open bead and stores the mapping in metadata', async () => {
    const runner = new FakeRunner([
      {
        stdout: JSON.stringify({
          'custom.github_project_sync.owner': 'axAilotl',
          'custom.github_project_sync.project_number': '2',
        }),
      },
      { stdout: JSON.stringify({ id: 'PVT_x' }) },
      {
        stdout: JSON.stringify([{
          id: 'PSFN-1',
          title: 'Fix sync path',
          description: 'Replace dead sync shellout.',
          status: 'open',
          priority: 2,
          issue_type: 'task',
          owner: 'axAilotl@pm.me',
        }]),
      },
      { stdout: JSON.stringify({ id: 'PVTI_item_1' }) },
      {
        stdout: JSON.stringify({
          data: {
            node: {
              content: {
                __typename: 'DraftIssue',
                id: 'DI_item_1',
              },
            },
          },
        }),
      },
      { stdout: JSON.stringify([{ id: 'PSFN-1' }]) },
    ]);

    const result = await syncMutatedBeadToGitHubProject(
      '/workspace',
      'create',
      'new',
      { id: 'PSFN-1' },
      runner as any,
    );

    expect(result).toMatchObject({
      integration: 'github_project',
      state: 'synced',
      owner: 'axAilotl',
      projectNumber: 2,
      issueId: 'PSFN-1',
      itemId: 'PVTI_item_1',
      draftContentId: 'DI_item_1',
      created: true,
    });
    expect(runner.calls.map((call) => call.command)).toEqual([
      'bd',
      'gh',
      'bd',
      'gh',
      'gh',
      'bd',
    ]);
    expect(runner.calls[3]?.args).toContain('item-create');
    expect(runner.calls[4]?.args).toEqual(expect.arrayContaining([
      'api',
      'graphql',
      '-F',
      'itemId=PVTI_item_1',
    ]));
    expect(runner.calls[5]?.args).toEqual(expect.arrayContaining([
      '--set-metadata',
      'github_project_sync_owner=axAilotl',
      '--set-metadata',
      'github_project_sync_project_number=2',
      '--set-metadata',
      'github_project_sync_item_id=PVTI_item_1',
      '--set-metadata',
      'github_project_sync_draft_content_id=DI_item_1',
    ]));
  });

  it('sets native status and priority number fields after creating a draft project item', async () => {
    const runner = new FakeRunner([
      {
        stdout: JSON.stringify({
          'custom.github_project_sync.owner': 'axAilotl',
          'custom.github_project_sync.project_number': '2',
          'custom.github_project_sync.fields.status.field_id': 'PVTSSF_status',
          'custom.github_project_sync.fields.status.options.open': 'status_open',
          'custom.github_project_sync.fields.status.options.in_progress': 'status_in_progress',
          'custom.github_project_sync.fields.status.options.blocked': 'status_blocked',
          'custom.github_project_sync.fields.status.options.closed': 'status_closed',
          'custom.github_project_sync.fields.priority.field_id': 'PVTF_priority',
          'custom.github_project_sync.fields.priority.type': 'number',
          'custom.github_project_sync.fields.priority.values.P0': '0',
          'custom.github_project_sync.fields.priority.values.P1': '10',
          'custom.github_project_sync.fields.priority.values.P2': '20',
          'custom.github_project_sync.fields.priority.values.P3': '30',
          'custom.github_project_sync.fields.priority.values.P4': '40',
        }),
      },
      { stdout: JSON.stringify({ id: 'PVT_project_2' }) },
      {
        stdout: JSON.stringify([{
          id: 'PSFN-10',
          title: 'Map fields',
          status: 'in_progress',
          priority: 2,
          issue_type: 'task',
        }]),
      },
      { stdout: JSON.stringify({ id: 'PVTI_item_fields' }) },
      {
        stdout: JSON.stringify({
          data: {
            node: {
              content: {
                __typename: 'DraftIssue',
                id: 'DI_item_fields',
              },
            },
          },
        }),
      },
      { stdout: JSON.stringify([{ id: 'PSFN-10' }]) },
      {
        stdout: JSON.stringify({
          data: {
            updateProjectV2ItemFieldValue: {
              projectV2Item: { id: 'PVTI_item_fields' },
            },
          },
        }),
      },
      {
        stdout: JSON.stringify({
          data: {
            updateProjectV2ItemFieldValue: {
              projectV2Item: { id: 'PVTI_item_fields' },
            },
          },
        }),
      },
    ]);

    const result = await syncMutatedBeadToGitHubProject(
      '/workspace',
      'create',
      'new',
      { id: 'PSFN-10' },
      runner as any,
    );

    expect(result).toMatchObject({
      integration: 'github_project',
      state: 'synced',
      owner: 'axAilotl',
      projectNumber: 2,
      issueId: 'PSFN-10',
      itemId: 'PVTI_item_fields',
      draftContentId: 'DI_item_fields',
      created: true,
    });
    expect(runner.calls.map((call) => call.command)).toEqual([
      'bd',
      'gh',
      'bd',
      'gh',
      'gh',
      'bd',
      'gh',
      'gh',
    ]);

    const statusMutation = runner.calls[6];
    expect(statusMutation.args).toEqual(expect.arrayContaining([
      'api',
      'graphql',
      '-F',
      'projectId=PVT_project_2',
      '-F',
      'itemId=PVTI_item_fields',
      '-F',
      'fieldId=PVTSSF_status',
    ]));
    const statusQuery = statusMutation.args.find((arg) => arg.startsWith('query='));
    expect(statusQuery).toContain('updateProjectV2ItemFieldValue');
    expect(statusQuery).toContain('singleSelectOptionId: "status_in_progress"');

    const priorityMutation = runner.calls[7];
    expect(priorityMutation.args).toEqual(expect.arrayContaining([
      'api',
      'graphql',
      '-F',
      'projectId=PVT_project_2',
      '-F',
      'itemId=PVTI_item_fields',
      '-F',
      'fieldId=PVTF_priority',
    ]));
    const priorityQuery = priorityMutation.args.find((arg) => arg.startsWith('query='));
    expect(priorityQuery).toContain('updateProjectV2ItemFieldValue');
    expect(priorityQuery).toContain('number: 20');
  });

  it('repairs missing draft content metadata before editing an existing synced draft issue', async () => {
    const runner = new FakeRunner([
      {
        stdout: JSON.stringify({
          'custom.github_project_sync.project_url': 'https://github.com/users/axAilotl/projects/2',
        }),
      },
      { stdout: JSON.stringify({ id: 'PVT_x' }) },
      {
        stdout: JSON.stringify([{
          id: 'PSFN-2',
          title: 'Repair synced item',
          status: 'open',
          metadata: {
            github_project_sync_owner: 'axAilotl',
            github_project_sync_project_number: 2,
            github_project_sync_item_id: 'PVTI_item_2',
          },
        }]),
      },
      {
        stdout: JSON.stringify({
          data: {
            node: {
              content: {
                __typename: 'DraftIssue',
                id: 'DI_item_2',
              },
            },
          },
        }),
      },
      { stdout: JSON.stringify({ id: 'DI_item_2' }) },
      { stdout: JSON.stringify([{ id: 'PSFN-2' }]) },
    ]);

    const result = await syncMutatedBeadToGitHubProject(
      '/workspace',
      'update',
      'PSFN-2',
      {},
      runner as any,
    );

    expect(result).toMatchObject({
      integration: 'github_project',
      state: 'synced',
      owner: 'axAilotl',
      projectNumber: 2,
      issueId: 'PSFN-2',
      itemId: 'PVTI_item_2',
      draftContentId: 'DI_item_2',
    });
    expect(runner.calls[3]?.args).toEqual(expect.arrayContaining([
      'api',
      'graphql',
      '-F',
      'itemId=PVTI_item_2',
    ]));
    expect(runner.calls[4]?.args).toEqual(expect.arrayContaining([
      'project',
      'item-edit',
      '--id',
      'DI_item_2',
    ]));
    expect(runner.calls[5]?.args).toEqual(expect.arrayContaining([
      '--set-metadata',
      'github_project_sync_draft_content_id=DI_item_2',
    ]));
  });

  it('sets native priority single-select fields when editing an existing synced draft issue', async () => {
    const runner = new FakeRunner([
      {
        stdout: JSON.stringify({
          'custom.github_project_sync.project_url': 'https://github.com/users/axAilotl/projects/2',
          'custom.github_project_sync.fields.priority.field_id': 'PVTSSF_priority',
          'custom.github_project_sync.fields.priority.type': 'single_select',
          'custom.github_project_sync.fields.priority.options.0': 'priority_p0',
          'custom.github_project_sync.fields.priority.options.1': 'priority_p1',
          'custom.github_project_sync.fields.priority.options.2': 'priority_p2',
          'custom.github_project_sync.fields.priority.options.3': 'priority_p3',
          'custom.github_project_sync.fields.priority.options.4': 'priority_p4',
        }),
      },
      { stdout: JSON.stringify({ id: 'PVT_project_2' }) },
      {
        stdout: JSON.stringify([{
          id: 'PSFN-11',
          title: 'Map priority select',
          status: 'open',
          priority: 0,
          metadata: {
            github_project_sync_owner: 'axAilotl',
            github_project_sync_project_number: 2,
            github_project_sync_item_id: 'PVTI_item_11',
            github_project_sync_draft_content_id: 'DI_item_11',
          },
        }]),
      },
      { stdout: JSON.stringify({ id: 'DI_item_11' }) },
      {
        stdout: JSON.stringify({
          data: {
            updateProjectV2ItemFieldValue: {
              projectV2Item: { id: 'PVTI_item_11' },
            },
          },
        }),
      },
    ]);

    const result = await syncMutatedBeadToGitHubProject(
      '/workspace',
      'update',
      'PSFN-11',
      {},
      runner as any,
    );

    expect(result).toMatchObject({
      integration: 'github_project',
      state: 'synced',
      owner: 'axAilotl',
      projectNumber: 2,
      issueId: 'PSFN-11',
      itemId: 'PVTI_item_11',
      draftContentId: 'DI_item_11',
    });
    expect(runner.calls[3]?.args).toEqual(expect.arrayContaining([
      'project',
      'item-edit',
      '--id',
      'DI_item_11',
    ]));
    expect(runner.calls[4]?.args).toEqual(expect.arrayContaining([
      'api',
      'graphql',
      '-F',
      'projectId=PVT_project_2',
      '-F',
      'itemId=PVTI_item_11',
      '-F',
      'fieldId=PVTSSF_priority',
    ]));
    const priorityQuery = runner.calls[4]?.args.find((arg) => arg.startsWith('query='));
    expect(priorityQuery).toContain('updateProjectV2ItemFieldValue');
    expect(priorityQuery).toContain('singleSelectOptionId: "priority_p0"');
  });

  it('archives the mapped project item when a synced bead closes', async () => {
    const runner = new FakeRunner([
      {
        stdout: JSON.stringify({
          'custom.github_project_sync.project_url': 'https://github.com/users/axAilotl/projects/2',
        }),
      },
      { stdout: JSON.stringify({ id: 'PVT_x' }) },
      {
        stdout: JSON.stringify([{
          id: 'PSFN-5',
          title: 'Close sync item',
          status: 'closed',
          metadata: {
            github_project_sync_owner: 'axAilotl',
            github_project_sync_project_number: 2,
            github_project_sync_item_id: 'PVTI_item_5',
            github_project_sync_draft_content_id: 'DI_item_5',
          },
        }]),
      },
      { stdout: JSON.stringify({ id: 'PVTI_item_5' }) },
      { stdout: JSON.stringify([{ id: 'PSFN-5' }]) },
    ]);

    const result = await syncMutatedBeadToGitHubProject(
      '/workspace',
      'close',
      'PSFN-5',
      [{ id: 'PSFN-5' }],
      runner as any,
    );

    expect(result).toMatchObject({
      integration: 'github_project',
      state: 'archived',
      owner: 'axAilotl',
      projectNumber: 2,
      issueId: 'PSFN-5',
      itemId: 'PVTI_item_5',
      draftContentId: 'DI_item_5',
    });
    expect(runner.calls[3]?.args).toEqual(expect.arrayContaining([
      'project',
      'item-archive',
      '2',
      '--owner',
      'axAilotl',
      '--id',
      'PVTI_item_5',
    ]));
    expect(runner.calls[4]?.args).toEqual(expect.arrayContaining([
      '--set-metadata',
      'github_project_sync_archived=1',
    ]));
  });

  it('fails closed when native status field config is incomplete', async () => {
    const runner = new FakeRunner([
      {
        stdout: JSON.stringify({
          'custom.github_project_sync.owner': 'axAilotl',
          'custom.github_project_sync.project_number': '2',
          'custom.github_project_sync.fields.status.field_id': 'PVTSSF_status',
          'custom.github_project_sync.fields.status.options.open': 'status_open',
        }),
      },
    ]);

    const result = await syncMutatedBeadToGitHubProject(
      '/workspace',
      'update',
      'PSFN-12',
      {},
      runner as any,
    );

    expect(result).toMatchObject({
      integration: 'github_project',
      state: 'error',
      reason: 'Invalid GitHub Project native-field config: custom.github_project_sync.fields.status.options.in_progress must be a non-empty single-select option id for status in_progress',
    });
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]?.command).toBe('bd');
  });

  it('fails closed when GitHub project auth does not return a project node id', async () => {
    const runner = new FakeRunner([
      {
        stdout: JSON.stringify({
          'custom.github_project_sync.owner': 'axAilotl',
          'custom.github_project_sync.project_number': '2',
          'custom.github_project_sync.fields.priority.field_id': 'PVTF_priority',
          'custom.github_project_sync.fields.priority.type': 'number',
        }),
      },
      { stdout: JSON.stringify({ title: 'No id visible' }) },
    ]);

    const result = await syncMutatedBeadToGitHubProject(
      '/workspace',
      'update',
      'PSFN-13',
      {},
      runner as any,
    );

    expect(result).toMatchObject({
      integration: 'github_project',
      state: 'error',
      owner: 'axAilotl',
      projectNumber: 2,
      issueId: 'PSFN-13',
      reason: 'gh project view axAilotl/2 returned no project id',
    });
    expect(runner.calls.map((call) => call.label)).toEqual([
      'bd config list',
      'gh project view axAilotl/2',
    ]);
  });

  it('returns a bulk error summary instead of aborting the entire sync on a single issue failure', async () => {
    const runner = new FakeRunner([
      {
        stdout: JSON.stringify({
          'custom.github_project_sync.owner': 'axAilotl',
          'custom.github_project_sync.project_number': '2',
        }),
      },
      { stdout: JSON.stringify({ id: 'PVT_x' }) },
      {
        stdout: [
          JSON.stringify({
            id: 'PSFN-3',
            title: 'Healthy issue',
            description: 'Should sync.',
            status: 'open',
            priority: 1,
            issue_type: 'task',
          }),
          JSON.stringify({
            id: 'PSFN-4',
            title: 'Broken issue',
            description: 'This one should fail.',
            status: 'open',
            priority: 2,
            issue_type: 'task',
          }),
        ].join('\n'),
      },
      { stdout: JSON.stringify({ id: 'PVTI_item_3' }) },
      {
        stdout: JSON.stringify({
          data: {
            node: {
              content: {
                __typename: 'DraftIssue',
                id: 'DI_item_3',
              },
            },
          },
        }),
      },
      { stdout: JSON.stringify([{ id: 'PSFN-3' }]) },
      { error: new Error('missing project scope') },
    ]);

    const result = await syncAllBeadsToGitHubProject('/workspace', runner as any);

    expect(result).toMatchObject({
      integration: 'github_project',
      state: 'error',
      owner: 'axAilotl',
      projectNumber: 2,
      totalIssues: 2,
      synced: 1,
      archived: 0,
      skipped: 0,
      errors: [
        {
          issueId: 'PSFN-4',
          message: 'missing project scope',
        },
      ],
    });
  });
});
