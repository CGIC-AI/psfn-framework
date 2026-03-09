// ── Vault Auto-Publisher ──
// Formats heartbeat reflections as markdown with YAML frontmatter and
// publishes them to the Obsidian vault. Used as a hook in the heartbeat
// reflection pipeline when Obsidian auto-publish is enabled in settings.json.

import type { VaultOperations } from './ops.js';
import { createComponentLogger } from '../logger.js';

const log = createComponentLogger('VaultAutoPublish');

export interface ReflectionPublishInput {
  templateId: string;
  templateName: string;
  reflection: string;
  mode: 'agent' | 'deliberation';
  createdAt: Date;
}

/** Maps template ID patterns to vault folder paths */
const FOLDER_MAP: Array<[RegExp, string]> = [
  [/^whisper$/i, 'Reflections/whisper/'],
  [/^daily/i, 'Reflections/daily/'],
  [/^emotional/i, 'Reflections/emotional/'],
  [/^goal/i, 'Reflections/goals/'],
  [/^values/i, 'Reflections/values/'],
];

const DEFAULT_FOLDER = 'Reflections/';

function resolveFolder(templateId: string): string {
  for (const [pattern, folder] of FOLDER_MAP) {
    if (pattern.test(templateId)) return folder;
  }
  return DEFAULT_FOLDER;
}

function formatNoteName(templateName: string, createdAt: Date): string {
  const date = createdAt.toISOString().slice(0, 10);
  const time = createdAt.toISOString().slice(11, 16).replace(':', 'h');
  // Whisper gets date-only; others get date + time to avoid collisions
  if (/whisper/i.test(templateName)) {
    return `${date} Whisper`;
  }
  return `${date} ${time} ${templateName}`;
}

function buildFrontmatter(input: ReflectionPublishInput): string {
  const lines = [
    '---',
    `template: ${input.templateId}`,
    `mode: ${input.mode}`,
    `date: ${input.createdAt.toISOString()}`,
    '---',
  ];
  return lines.join('\n');
}

export class VaultAutoPublisher {
  private readonly ops: VaultOperations;

  constructor(ops: VaultOperations) {
    this.ops = ops;
  }

  async publishReflection(input: ReflectionPublishInput): Promise<void> {
    const folder = resolveFolder(input.templateId);
    const name = formatNoteName(input.templateName, input.createdAt);
    const frontmatter = buildFrontmatter(input);
    const content = `${frontmatter}\n\n${input.reflection}`;

    await this.ops.write(name, content, { folder, mode: 'create' });
    log.debug('Published reflection to vault', {
      templateId: input.templateId,
      folder,
      name,
    });
  }
}
