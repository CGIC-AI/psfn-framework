/**
 * Static scanner for explicit vitest timeout overrides in integration tests.
 *
 * The timeout-margin policy (see `integration-timeout-registry.json`) requires
 * every explicit per-test / per-hook timeout override in an `*.integration.test.ts`
 * file to be registered with a measured baseline and adequate headroom. This
 * module parses the test sources with the TypeScript compiler API and reports
 * the distinct override values found per file, so the policy test can check them
 * against the checked-in registry. It performs no I/O beyond reading the files
 * it is handed; discovery of the file set lives in the caller.
 */

import { readFileSync } from 'node:fs';
import ts from 'typescript';

/** Callee identifiers that accept a trailing/positional timeout argument. */
const TEST_CASE_CALLEES = new Set(['it', 'test', 'fit', 'xit']);
const HOOK_CALLEES = new Set(['beforeAll', 'afterAll', 'beforeEach', 'afterEach']);
const SUITE_CALLEES = new Set(['describe', 'suite']);

export interface TimeoutOverrideSite {
  readonly callee: string;
  readonly line: number;
  readonly timeoutMs: number;
}

export interface FileOverrideScan {
  readonly file: string;
  readonly sites: readonly TimeoutOverrideSite[];
  /** Sorted, de-duplicated distinct timeout values used in the file. */
  readonly distinctTimeoutMs: readonly number[];
}

/** Strip `as const` / `satisfies` / parentheses / `<T>` assertions. */
function unwrapExpression(node: ts.Expression): ts.Expression {
  let current = node;
  while (
    ts.isAsExpression(current)
    || ts.isSatisfiesExpression(current)
    || ts.isParenthesizedExpression(current)
    || ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function numericLiteralValue(node: ts.Node): number | undefined {
  const target = ts.isExpression(node) ? unwrapExpression(node) : node;
  if (ts.isNumericLiteral(target)) {
    // NumericLiteral text preserves separators (e.g. "120_000").
    const value = Number(target.text.replaceAll('_', ''));
    return Number.isFinite(value) ? value : undefined;
  }
  return undefined;
}

/**
 * Collect a lookup of resolvable numeric constants declared in the file:
 *   - `const X = 120_000;`               -> { "X": 120000 }
 *   - `const O = { timeoutMs: 120_000 };` -> { "O.timeoutMs": 120000 }
 */
function collectNumericConstants(source: ts.SourceFile): Map<string, number> {
  const constants = new Map<string, number>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.name)) {
      const initializer = unwrapExpression(node.initializer);
      const literal = numericLiteralValue(initializer);
      if (literal !== undefined) {
        constants.set(node.name.text, literal);
      } else if (ts.isObjectLiteralExpression(initializer)) {
        for (const property of initializer.properties) {
          if (
            ts.isPropertyAssignment(property)
            && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
          ) {
            const memberValue = numericLiteralValue(property.initializer);
            if (memberValue !== undefined) {
              constants.set(`${node.name.text}.${property.name.text}`, memberValue);
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return constants;
}

/** Resolve the base identifier of a (possibly chained) call expression callee. */
function calleeRootName(expression: ts.Expression): string | undefined {
  let current: ts.Expression = expression;
  for (;;) {
    if (ts.isIdentifier(current)) return current.text;
    if (ts.isPropertyAccessExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isCallExpression(current)) {
      // e.g. `it.each(cases)('name', fn, timeout)` -> unwrap to `it.each` -> `it`.
      current = current.expression;
      continue;
    }
    if (ts.isElementAccessExpression(current)) {
      current = current.expression;
      continue;
    }
    return undefined;
  }
}

function resolveTimeoutArgument(
  node: ts.Expression,
  constants: Map<string, number>,
): number | undefined {
  const target = unwrapExpression(node);
  const literal = numericLiteralValue(target);
  if (literal !== undefined) return literal;
  if (ts.isIdentifier(target)) return constants.get(target.text);
  if (ts.isPropertyAccessExpression(target)) {
    const owner = target.expression;
    if (ts.isIdentifier(owner)) return constants.get(`${owner.text}.${target.name.text}`);
  }
  return undefined;
}

/**
 * Extract the timeout override, if any, carried by a single call expression.
 * Handles the positional forms vitest accepts:
 *   - it/test:  (name, fn, timeout)  and  (name, { timeout }, fn)
 *   - hooks:    (fn, timeout)
 *   - describe: (name, fn, timeout)
 */
function extractOverride(
  call: ts.CallExpression,
  root: string,
  constants: Map<string, number>,
): number | undefined {
  const args = call.arguments;

  // Options-object form: it('name', { timeout: N }, fn).
  for (const arg of args) {
    if (ts.isObjectLiteralExpression(arg)) {
      for (const property of arg.properties) {
        if (
          ts.isPropertyAssignment(property)
          && ts.isIdentifier(property.name)
          && property.name.text === 'timeout'
        ) {
          const value = resolveTimeoutArgument(property.initializer, constants);
          if (value !== undefined) return value;
        }
      }
    }
  }

  if (HOOK_CALLEES.has(root)) {
    // (fn, timeout)
    const timeoutArg = args.at(1);
    return timeoutArg ? resolveTimeoutArgument(timeoutArg, constants) : undefined;
  }

  if (TEST_CASE_CALLEES.has(root) || SUITE_CALLEES.has(root)) {
    // (name, fn, timeout) — timeout is the third positional argument.
    const timeoutArg = args.at(2);
    return timeoutArg ? resolveTimeoutArgument(timeoutArg, constants) : undefined;
  }

  return undefined;
}

/** Scan a single test source string for explicit timeout override sites. */
export function scanSourceForTimeoutOverrides(
  file: string,
  sourceText: string,
): FileOverrideScan {
  const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true);
  const constants = collectNumericConstants(source);
  const sites: TimeoutOverrideSite[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const root = calleeRootName(node.expression);
      if (root && (TEST_CASE_CALLEES.has(root) || HOOK_CALLEES.has(root) || SUITE_CALLEES.has(root))) {
        const timeoutMs = extractOverride(node, root, constants);
        if (timeoutMs !== undefined) {
          const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
          sites.push({ callee: root, line: line + 1, timeoutMs });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  const distinctTimeoutMs = [...new Set(sites.map(site => site.timeoutMs))].sort((a, b) => a - b);
  return { file, sites, distinctTimeoutMs };
}

/** Scan a file on disk (path relative to the repo root or absolute). */
export function scanFileForTimeoutOverrides(
  relativePath: string,
  absolutePath: string,
): FileOverrideScan {
  return scanSourceForTimeoutOverrides(relativePath, readFileSync(absolutePath, 'utf8'));
}
