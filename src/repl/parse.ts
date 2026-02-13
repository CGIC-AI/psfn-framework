// ── RLM Response Parser ──
// Extracts code blocks, FINAL() calls, and FINAL_VAR() calls from LLM responses.

export type ParsedAction =
  | { type: 'final'; answer: string }
  | { type: 'final_var'; varName: string }
  | { type: 'code'; code: string }
  | { type: 'none' };

// Strip fenced code blocks from text so FINAL detection doesn't match inside code
function stripCodeBlocks(text: string): string {
  return text.replace(/```[\s\S]*?```/g, '');
}

/**
 * Extract the first fenced code block with a recognized language tag.
 * Accepts: ```repl, ```javascript, ```js, or bare ```.
 */
export function extractCodeBlock(text: string): string | null {
  const match = text.match(/```(?:repl|javascript|js)?\s*\n([\s\S]*?)```/);
  return match ? match[1].trimEnd() : null;
}

/**
 * Detect FINAL("answer") or FINAL('answer') outside of code blocks.
 * The answer is extracted from the quotes.
 */
export function detectFinalInText(text: string): string | null {
  const stripped = stripCodeBlocks(text);
  const match = stripped.match(/FINAL\(\s*(?:"([\s\S]*?)"|'([\s\S]*?)'|`([\s\S]*?)`)\s*\)/);
  if (!match) return null;
  return match[1] ?? match[2] ?? match[3] ?? null;
}

/**
 * Detect FINAL_VAR(varName) outside of code blocks.
 */
export function detectFinalVar(text: string): string | null {
  const stripped = stripCodeBlocks(text);
  const match = stripped.match(/FINAL_VAR\(\s*(\w+)\s*\)/);
  return match ? match[1] : null;
}

/**
 * Unified response parser. Checks FINAL before code (priority order).
 */
export function parseResponse(text: string): ParsedAction {
  // 1. Check for FINAL("answer") in text (outside code blocks)
  const finalAnswer = detectFinalInText(text);
  if (finalAnswer !== null) {
    return { type: 'final', answer: finalAnswer };
  }

  // 2. Check for FINAL_VAR(name) in text (outside code blocks)
  const finalVar = detectFinalVar(text);
  if (finalVar !== null) {
    return { type: 'final_var', varName: finalVar };
  }

  // 3. Check for code block
  const code = extractCodeBlock(text);
  if (code !== null) {
    return { type: 'code', code };
  }

  return { type: 'none' };
}
