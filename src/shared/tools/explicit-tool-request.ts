const EXPLICIT_TOOL_VERBS = '(?:call|use|invoke|run|execute|trigger)';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/**
 * Resolve active tools that the participant explicitly instructed the agent to
 * execute. Merely mentioning or asking about a tool is intentionally excluded.
 */
export function resolveExplicitlyRequestedToolNames(
  requestText: string,
  activeToolNames: readonly string[],
): string[] {
  const matches: Array<{ name: string; index: number }> = [];
  for (const rawName of activeToolNames) {
    const name = rawName.trim();
    if (!name) continue;
    const pattern = new RegExp(
      `\\b${EXPLICIT_TOOL_VERBS}\\s+(?:the\\s+)?(?:tool\\s+)?[\u0060]?${escapeRegExp(name)}[\u0060]?(?=\\s|[.,;:!?)]|$)`,
      'iu',
    );
    const match = pattern.exec(requestText);
    if (match) matches.push({ name, index: match.index });
  }
  return matches
    .sort((left, right) => left.index - right.index || left.name.localeCompare(right.name))
    .map(match => match.name);
}
