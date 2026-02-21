import type {
  SkillBudget,
  SkillEntry,
  SkillFormatResult,
  SkillSkipRecord,
} from './types.js';

function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeXmlAttribute(value: string): string {
  return escapeXmlText(value).replace(/"/g, '&quot;');
}

function sortSkillsForPrompt(entries: SkillEntry[]): SkillEntry[] {
  return [...entries].sort((left, right) => {
    if (left.always !== right.always) {
      return left.always ? -1 : 1;
    }
    if (left.precedence !== right.precedence) {
      return left.precedence - right.precedence;
    }
    return left.name.localeCompare(right.name);
  });
}

function renderSkillNode(entry: SkillEntry): string {
  const header = `  <skill name="${escapeXmlAttribute(entry.name)}" source="${escapeXmlAttribute(entry.source)}" path="${escapeXmlAttribute(entry.relativePath)}" always="${entry.always ? 'true' : 'false'}">`;
  const description = `    <description>${escapeXmlText(entry.description)}</description>`;
  const instructions = entry.content.trim().length > 0
    ? `    <instructions>${escapeXmlText(entry.content.trim())}</instructions>`
    : '';
  const footer = '  </skill>';

  return [header, description, instructions, footer]
    .filter(Boolean)
    .join('\n');
}

function budgetBoundedInteger(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value < 1) return fallback;
  return Math.trunc(value);
}

export function formatSkillsForPrompt(
  entries: SkillEntry[],
  budget: SkillBudget,
): SkillFormatResult {
  const maxSkills = budgetBoundedInteger(budget.maxSkills, 32);
  const maxChars = budgetBoundedInteger(budget.maxChars, 24_000);

  const sorted = sortSkillsForPrompt(entries);
  const included: SkillEntry[] = [];
  const excluded: SkillSkipRecord[] = [];
  const skillNodes: string[] = [];

  for (const entry of sorted) {
    if (included.length >= maxSkills) {
      excluded.push({
        kind: 'budget',
        name: entry.name,
        relativePath: entry.relativePath,
        source: entry.source,
        reason: `Excluded by maxLoadedSkills limit (${maxSkills})`,
        details: ['maxLoadedSkills'],
      });
      continue;
    }

    const candidateNode = renderSkillNode(entry);
    const candidateNodes = [...skillNodes, candidateNode];
    const candidateXml = ['<skills>', ...candidateNodes, '</skills>'].join('\n');
    if (candidateXml.length > maxChars) {
      excluded.push({
        kind: 'budget',
        name: entry.name,
        relativePath: entry.relativePath,
        source: entry.source,
        reason: `Excluded by maxSkillChars limit (${maxChars})`,
        details: ['maxSkillChars'],
      });
      continue;
    }

    included.push(entry);
    skillNodes.push(candidateNode);
  }

  if (included.length === 0) {
    return {
      xml: '',
      included,
      excluded,
      totalChars: 0,
    };
  }

  const xml = ['<skills>', ...skillNodes, '</skills>'].join('\n');
  return {
    xml,
    included,
    excluded,
    totalChars: xml.length,
  };
}
