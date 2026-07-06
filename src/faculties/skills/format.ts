import type {
  SkillBudget,
  SkillEntry,
  SkillFormatResult,
  SkillSkipRecord,
} from './types.js';
import { escapeXmlAttribute, escapeXmlText } from '../../shared/utils/escaping.js';

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
  const attributes = [
    `name="${escapeXmlAttribute(entry.name)}"`,
    `source="${escapeXmlAttribute(entry.source)}"`,
    `path="${escapeXmlAttribute(entry.relativePath)}"`,
    `always="${entry.always ? 'true' : 'false'}"`,
    ...(entry.category ? [`category="${escapeXmlAttribute(entry.category)}"`] : []),
    ...(entry.version !== undefined ? [`version="${entry.version}"`] : []),
  ];
  const header = `  <skill ${attributes.join(' ')}>`;
  const description = `    <summary>${escapeXmlText(entry.description)}</summary>`;
  const footer = '  </skill>';

  return [header, description, footer]
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
    const candidateXml = ['<skills_index>', ...candidateNodes, '</skills_index>'].join('\n');
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

  const xml = ['<skills_index>', ...skillNodes, '</skills_index>'].join('\n');
  return {
    xml,
    included,
    excluded,
    totalChars: xml.length,
  };
}
