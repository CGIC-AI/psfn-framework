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
  [/^musing$/i, 'Reflections/musings/'],
  [/^daily/i, 'Reflections/daily/'],
  [/^emotional/i, 'Reflections/emotional/'],
  [/^goal/i, 'Reflections/goals/'],
  [/^values/i, 'Reflections/values/'],
];

const DEFAULT_FOLDER = 'Reflections/';

function normalizeTemplateId(templateId: string): string {
  const normalized = templateId.trim();
  return /^whisper$/i.test(normalized) ? 'musing' : normalized;
}

function resolveFolder(templateId: string): string {
  const normalizedTemplateId = normalizeTemplateId(templateId);
  for (const [pattern, folder] of FOLDER_MAP) {
    if (pattern.test(normalizedTemplateId)) return folder;
  }
  return DEFAULT_FOLDER;
}

function formatNoteName(templateName: string, createdAt: Date): string {
  const date = createdAt.toISOString().slice(0, 10);
  const time = createdAt.toISOString().slice(11, 16).replace(':', 'h');
  // Musing notes get date-only; others get date + time to avoid collisions
  if (/musing/i.test(templateName)) {
    return `${date} Musing`;
  }
  return `${date} ${time} ${templateName}`;
}

function buildFrontmatter(input: ReflectionPublishInput): string {
  const templateId = normalizeTemplateId(input.templateId);
  const lines = [
    '---',
    `template: ${templateId}`,
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
    const templateId = normalizeTemplateId(input.templateId);
    const folder = resolveFolder(templateId);
    const name = formatNoteName(input.templateName, input.createdAt);
    const frontmatter = buildFrontmatter({ ...input, templateId });
    const content = `${frontmatter}\n\n${input.reflection}`;

    await this.ops.write(name, content, { folder, mode: 'create' });
    log.debug('Published reflection to vault', {
      templateId,
      folder,
      name,
    });
  }
}
