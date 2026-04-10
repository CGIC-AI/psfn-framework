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
  const matches = [...text.matchAll(/```(?:repl|javascript|js)?\s*\n([\s\S]*?)```/g)];
  const match = matches.at(-1);
  return match ? match[1].trimEnd() : null;
}

/**
 * Detect FINAL(...) outside of code blocks.
 * Quoted values are unwrapped; raw payloads are returned as-is after trimming.
 */
export function detectFinalInText(text: string): string | null {
  const stripped = stripCodeBlocks(text);
  const start = stripped.indexOf('FINAL(');
  if (start === -1) return null;

  let index = start + 'FINAL('.length;
  let depth = 1;
  let quote: '"' | '\'' | '`' | null = null;
  let escaped = false;

  for (; index < stripped.length; index += 1) {
    const char = stripped[index];
    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === '\'' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '(') {
      depth += 1;
      continue;
    }
    if (char === ')') {
      depth -= 1;
      if (depth === 0) {
        break;
      }
    }
  }

  if (depth !== 0) return null;

  const payload = stripped.slice(start + 'FINAL('.length, index).trim();
  if (!payload) return '';

  const quoteChar = payload[0];
  if (
    (quoteChar === '"' || quoteChar === '\'' || quoteChar === '`')
    && payload.at(-1) === quoteChar
  ) {
    return payload.slice(1, -1);
  }

  return payload;
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
