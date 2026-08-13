const EXPLICIT_TOOL_VERBS = '(?:call|use|invoke|run|execute|trigger|attempt)';

/**
 * Document ingest appends runtime-derived attachment data after this boundary.
 * Only the participant-authored prefix may opt into forced tool execution.
 */
export const DERIVED_ATTACHMENT_CONTEXT_BOUNDARY =
  '[Runtime note] The following attachment context was derived by the runtime from Participant-provided files.';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function directiveSentenceAt(requestText: string, matchIndex: number, matchEnd: number): string {
  let sentenceStart = 0;
  const priorText = requestText.slice(0, matchIndex);
  for (const boundary of priorText.matchAll(/[.!?]["')\]]*\s+(?=[\p{Lu}\p{Lt}])/gu)) {
    sentenceStart = boundary.index + boundary[0].length;
  }
  const remainingText = requestText.slice(matchEnd);
  const nextBoundary = /[.!?]["')\]]*(?=\s+[\p{Lu}\p{Lt}]|$)/u.exec(remainingText);
  const sentenceEnd = nextBoundary
    ? matchEnd + nextBoundary.index + nextBoundary[0].length
    : requestText.length;
  return requestText.slice(sentenceStart, sentenceEnd);
}

function isProhibitedToolDirective(
  requestText: string,
  matchIndex: number,
  matchEnd: number,
): boolean {
  return /\b(?:no|not|never|avoid|forbid|forbidden|prohibit|prohibited|refrain|without)\b|n['’]t\b/iu
    .test(directiveSentenceAt(requestText, matchIndex, matchEnd));
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
  const attachmentBoundaryIndex = requestText.indexOf(DERIVED_ATTACHMENT_CONTEXT_BOUNDARY);
  const participantRequestText = attachmentBoundaryIndex >= 0
    ? requestText.slice(0, attachmentBoundaryIndex)
    : requestText;
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
    for (const match of participantRequestText.matchAll(pattern)) {
      const matchEnd = match.index + match[0].length;
      if (isProhibitedToolDirective(participantRequestText, match.index, matchEnd)) continue;
      const clauseSuffix = participantRequestText
        .slice(matchEnd)
        .split(/[.;!?]/u, 1)[0] ?? '';
      matches.push({
        name,
        index: match.index,
        end: matchEnd,
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
    const actionMatches = [...participantRequestText.matchAll(actionPattern)];
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
        ? participantRequestText.slice(previousActionEnd, actionIndex)
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
  return matches
    .sort((left, right) => left.index - right.index || left.name.localeCompare(right.name))
    .flatMap(match => Array.from({ length: match.repeatCount }, () => match.name));
}
