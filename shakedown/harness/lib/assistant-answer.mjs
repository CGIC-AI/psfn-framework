// Parse-tolerant reading of a companion's JSON answer (psfn-framework-7wa3d).
//
// A companion that returns the correct values inside imperfect JSON (prose
// around the object, a second object, duplicate keys) has answered the
// question. The harness reads the first well-formed JSON object it can find
// and lets the case validators judge the required values; the malformation
// itself is recorded as companion feedback, never as a failure. An answer with
// no parseable object at all still yields `null`, so a case whose required
// keys are missing keeps failing.

function stripJsonCodeFence(text) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```/i);
  return fenced ? fenced[1].trim() : trimmed;
}

/** Every top-level `{...}` span, scanned with string/escape awareness. */
function balancedObjectSpans(text) {
  const spans = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      if (depth > 0) inString = true;
    } else if (char === '{') {
      if (depth === 0) start = index;
      depth += 1;
    } else if (char === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0) spans.push(text.slice(start, index + 1));
    }
  }
  return spans;
}

/**
 * Keys that appear more than once inside one object literal, with every value
 * seen, in order. `JSON.parse` silently keeps the last one; the answer is
 * still read that way, but the duplication is reported.
 */
function findDuplicateKeys(objectText) {
  const duplicates = {};
  const stack = [];
  let index = 0;
  const skipWhitespace = () => {
    while (index < objectText.length && /\s/.test(objectText[index])) index += 1;
  };
  const readString = () => {
    const begin = index;
    index += 1;
    while (index < objectText.length) {
      if (objectText[index] === '\\') index += 2;
      else if (objectText[index] === '"') { index += 1; break; }
      else index += 1;
    }
    return JSON.parse(objectText.slice(begin, index));
  };
  const readValueText = () => {
    const begin = index;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (; index < objectText.length; index += 1) {
      const char = objectText[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === '{' || char === '[') depth += 1;
      else if (char === '}' || char === ']') {
        if (depth === 0) break;
        depth -= 1;
      } else if (char === ',' && depth === 0) break;
    }
    return objectText.slice(begin, index).trim();
  };
  const walkObject = (path) => {
    const seen = new Map();
    index += 1;
    for (;;) {
      skipWhitespace();
      if (objectText[index] === '}') { index += 1; break; }
      if (objectText[index] !== '"') return;
      const key = readString();
      skipWhitespace();
      if (objectText[index] !== ':') return;
      index += 1;
      skipWhitespace();
      const valueStart = index;
      let valueText;
      if (objectText[index] === '{') {
        walkObject([...path, key]);
        valueText = objectText.slice(valueStart, index);
      } else {
        valueText = readValueText();
      }
      const values = seen.get(key) ?? [];
      values.push(valueText);
      seen.set(key, values);
      skipWhitespace();
      if (objectText[index] === ',') index += 1;
    }
    for (const [key, values] of seen) {
      if (values.length > 1) duplicates[[...path, key].join('.')] = values;
    }
  };
  skipWhitespace();
  if (objectText[index] === '{') walkObject(stack);
  return duplicates;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Read a companion's JSON answer.
 *
 * Returns `{ value, malformation }`: `value` is the parsed answer (or `null`
 * when nothing parseable exists), and `malformation` is `null` for a clean
 * answer or a content-bounded description of what was wrong with it.
 */
export function readAssistantAnswer(text) {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return { value: null, malformation: null };
  }
  const stripped = stripJsonCodeFence(text);
  try {
    const value = JSON.parse(stripped);
    const duplicateKeys = isPlainObject(value) ? findDuplicateKeys(stripped) : {};
    return {
      value,
      malformation: Object.keys(duplicateKeys).length > 0
        ? { reason: 'duplicate_keys', duplicateKeys }
        : null,
    };
  } catch {
    // Not a single JSON document: look for embedded objects below.
  }
  const spans = balancedObjectSpans(stripped);
  const parsed = [];
  for (const span of spans) {
    try {
      parsed.push({ span, value: JSON.parse(span) });
    } catch {
      // An unparseable span is itself part of the malformation.
    }
  }
  if (parsed.length === 0) {
    return { value: null, malformation: { reason: 'unparseable', objectCount: spans.length } };
  }
  const [first] = parsed;
  const duplicateKeys = findDuplicateKeys(first.span);
  return {
    value: first.value,
    malformation: {
      reason: spans.length > 1 ? 'multiple_objects' : 'surrounding_text',
      objectCount: spans.length,
      parsedObjectCount: parsed.length,
      ...(Object.keys(duplicateKeys).length > 0 ? { duplicateKeys } : {}),
    },
  };
}

/** The companion-feedback entry for a malformed answer, or none. */
export function malformedAnswerFeedback(malformation) {
  return malformation ? [{ kind: 'malformed_answer', value: malformation }] : [];
}
