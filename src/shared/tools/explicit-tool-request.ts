const EXPLICIT_TOOL_VERBS = '(?:call|use|invoke|run|execute|trigger|attempt)';

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
  return [...new Set(resolveExplicitToolRequestSequence(requestText, activeToolNames))];
}

/** Preserve every explicitly requested step, including repeated calls to one tool. */
export function resolveExplicitToolRequestSequence(
  requestText: string,
  activeToolNames: readonly string[],
): string[] {
  const matches: Array<{ name: string; index: number }> = [];
  for (const rawName of activeToolNames) {
    const name = rawName.trim();
    if (!name) continue;
    const pattern = new RegExp(
      `\\b${EXPLICIT_TOOL_VERBS}\\s+(?:the\\s+)?(?:tool\\s+)?[\u0060]?${escapeRegExp(name)}[\u0060]?(?=\\s|[.,;:!?)]|$)`,
      'giu',
    );
    for (const match of requestText.matchAll(pattern)) {
      const prefix = requestText.slice(0, match.index);
      if (/\b(?:do\s+not|don't|never)\s*$/iu.test(prefix)) continue;
      matches.push({ name, index: match.index });
    }
  }
  return matches
    .sort((left, right) => left.index - right.index || left.name.localeCompare(right.name))
    .map(match => match.name);
}
