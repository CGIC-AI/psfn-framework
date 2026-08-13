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
  const matches: Array<{ name: string; index: number; repeatCount: number }> = [];
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
      const clauseSuffix = requestText
        .slice(match.index + match[0].length)
        .split(/[.;!?]/u, 1)[0] ?? '';
      matches.push({
        name,
        index: match.index,
        repeatCount: /\b(?:exactly\s+)?twice\b/iu.test(clauseSuffix) ? 2 : 1,
      });
    }
  }
  return matches
    .sort((left, right) => left.index - right.index || left.name.localeCompare(right.name))
    .flatMap(match => Array.from({ length: match.repeatCount }, () => match.name));
}
