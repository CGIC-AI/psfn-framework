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
  const matches: Array<{
    name: string;
    index: number;
    end: number;
    repeatCount: number;
    explicit: boolean;
  }> = [];
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
        end: match.index + match[0].length,
        repeatCount: /\b(?:exactly\s+)?twice\b/iu.test(clauseSuffix) ? 2 : 1,
        explicit: true,
      });
    }

    // One leading imperative can govern a comma-separated series of actions
    // on the same tool: "use orient with action A, orient with action B, and
    // orient with action C". Preserve those elided steps without treating an
    // arbitrary later mention as another invocation.
    const actionPattern = new RegExp(
      `[\u0060]?${escapeRegExp(name)}[\u0060]?\\s+with\\s+action\\s+(?:"[^"]+"|'[^']+'|[\\w-]+)`,
      'giu',
    );
    const actionMatches = [...requestText.matchAll(actionPattern)];
    let activeSeries = false;
    let previousActionEnd = -1;
    for (const actionMatch of actionMatches) {
      const actionIndex = actionMatch.index;
      const actionEnd = actionIndex + actionMatch[0].length;
      const coveredByExplicitMatch = matches.some(match => (
        match.name === name
        && match.explicit
        && match.index <= actionIndex
        && match.end >= actionIndex + name.length
      ));
      const connector = previousActionEnd >= 0
        ? requestText.slice(previousActionEnd, actionIndex)
        : '';
      const continuesSeries: boolean = activeSeries
        && /^\s*,\s*(?:and\s+)?$/iu.test(connector);
      if (!coveredByExplicitMatch && continuesSeries) {
        matches.push({
          name,
          index: actionIndex,
          end: actionEnd,
          repeatCount: 1,
          explicit: false,
        });
      }
      activeSeries = coveredByExplicitMatch || continuesSeries;
      previousActionEnd = actionEnd;
    }
  }
  const ordered = matches
    .sort((left, right) => left.index - right.index || left.name.localeCompare(right.name));
  const steps: typeof ordered = [];
  for (const match of ordered) {
    const previous = steps.at(-1);
    if (
      match.explicit
      && previous?.explicit
      && previous.name === match.name
      && previous.repeatCount === 1
      && match.repeatCount === 1
    ) {
      const connector = requestText.slice(previous.end, match.index);
      const startsAnotherStep = /\b(?:then|next|afterwards?|subsequently)\b/iu.test(connector)
        || /(?:^|[,;])\s*and\s*$/iu.test(connector);
      if (!startsAnotherStep) continue;
    }
    steps.push(match);
  }
  return steps.flatMap(match => Array.from({ length: match.repeatCount }, () => match.name));
}
