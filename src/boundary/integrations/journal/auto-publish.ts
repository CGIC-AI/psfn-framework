import type { JournalOperations } from './ops.js';
import { createComponentLogger } from '../../../shared/logger.js';

const log = createComponentLogger('JournalAutoPublish');

export interface ReflectionPublishInput {
  templateId: string;
  templateName: string;
  reflection: string;
  mode: 'agent' | 'deliberation';
  createdAt: Date;
}

const FOLDER_MAP: Array<[RegExp, string]> = [
  [/^musing$/i, 'reflections/musings'],
  [/^daily/i, 'reflections/daily'],
  [/^weekly/i, 'reflections/weekly'],
  [/^emotional/i, 'reflections/emotional'],
  [/^goal/i, 'reflections/goals'],
  [/^values/i, 'reflections/values'],
];

const DEFAULT_FOLDER = 'reflections';

function normalizeTemplateId(templateId: string): string {
  const normalized = templateId.trim();
  return /^whisper$/i.test(normalized) ? 'musing' : normalized;
}

function normalizeTemplateName(templateName: string): string {
  const normalized = templateName.trim();
  return /^whisper$/i.test(normalized) ? 'Musing' : normalized;
}

function resolveFolder(templateId: string): string {
  const normalizedTemplateId = normalizeTemplateId(templateId);
  for (const [pattern, folder] of FOLDER_MAP) {
    if (pattern.test(normalizedTemplateId)) return folder;
  }
  return DEFAULT_FOLDER;
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'reflection';
}

function formatNotePath(templateName: string, createdAt: Date): string {
  const date = createdAt.toISOString().slice(0, 10);
  const time = createdAt.toISOString().slice(11, 16).replace(':', 'h');
  const normalizedName = normalizeTemplateName(templateName);
  if (/musing/i.test(normalizedName)) {
    return `${date}-musing.md`;
  }
  return `${date}-${time}-${slugify(normalizedName)}.md`;
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

export class JournalAutoPublisher {
  constructor(private readonly ops: JournalOperations) {}

  async publishReflection(input: ReflectionPublishInput): Promise<void> {
    const templateId = normalizeTemplateId(input.templateId);
    const folder = resolveFolder(templateId);
    const notePath = `${folder}/${formatNotePath(input.templateName, input.createdAt)}`;
    const frontmatter = buildFrontmatter({ ...input, templateId });
    const content = `${frontmatter}\n\n${input.reflection}`;

    await this.ops.write(notePath, content);
    log.debug('Published reflection to journal', {
      templateId,
      path: notePath,
    });
  }
}
