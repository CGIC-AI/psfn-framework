import { basename, isAbsolute, resolve } from 'node:path';
import type { ShellExecParams } from './protocol.js';

export interface ShellMutationTarget {
  path: string;
  includeOwnerContainers: boolean;
}

type ShellToken =
  | { kind: 'word'; value: string }
  | { kind: 'nested_script'; value: string }
  | { kind: 'separator' }
  | { kind: 'output_redirect' }
  | { kind: 'input_redirect' };

function consumeCommandSubstitution(
  script: string,
  startIndex: number,
): { script: string; endIndex: number } | null {
  if (script[startIndex] !== '$' || script[startIndex + 1] !== '('
    || script[startIndex + 2] === '(') return null;
  let depth = 1;
  let quote: 'single' | 'double' | null = null;
  for (let index = startIndex + 2; index < script.length; index += 1) {
    const char = script[index];
    if (quote === 'single') {
      if (char === "'") quote = null;
      continue;
    }
    if (quote === 'double') {
      if (char === '"') quote = null;
      else if (char === '\\') index += 1;
      continue;
    }
    if (char === "'") {
      quote = 'single';
      continue;
    }
    if (char === '"') {
      quote = 'double';
      continue;
    }
    if (char === '\\') {
      index += 1;
      continue;
    }
    if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth === 0) {
        return {
          script: script.slice(startIndex + 2, index),
          endIndex: index,
        };
      }
    }
  }
  return null;
}

function consumeBacktickSubstitution(
  script: string,
  startIndex: number,
): { script: string; endIndex: number } | null {
  if (script[startIndex] !== '`') return null;
  for (let index = startIndex + 1; index < script.length; index += 1) {
    if (script[index] === '\\') {
      index += 1;
      continue;
    }
    if (script[index] === '`') {
      return {
        script: script.slice(startIndex + 1, index),
        endIndex: index,
      };
    }
  }
  return null;
}

function decodeAnsiCodePoint(digits: string, radix: number, fallback: string): string {
  const value = Number.parseInt(digits, radix);
  if (!Number.isSafeInteger(value) || value < 0 || value > 0x10_FFFF) return fallback;
  return String.fromCodePoint(value);
}

function consumeAnsiEscape(script: string, slashIndex: number): { value: string; endIndex: number } {
  if (slashIndex + 1 >= script.length) return { value: '\\', endIndex: slashIndex };
  const escaped = script[slashIndex + 1];
  const simpleEscapes: Readonly<Record<string, string>> = {
    a: '\x07',
    b: '\b',
    e: '\x1b',
    E: '\x1b',
    f: '\f',
    n: '\n',
    r: '\r',
    t: '\t',
    v: '\v',
    '\\': '\\',
    "'": "'",
  };
  if (Object.prototype.hasOwnProperty.call(simpleEscapes, escaped)) {
    return { value: simpleEscapes[escaped], endIndex: slashIndex + 1 };
  }
  const numeric = script.slice(slashIndex + 1);
  const hexadecimal = numeric.match(/^x([0-9a-f]{1,2})/iu);
  if (hexadecimal) {
    return {
      value: decodeAnsiCodePoint(hexadecimal[1], 16, escaped),
      endIndex: slashIndex + hexadecimal[0].length,
    };
  }
  const unicode = numeric.match(/^u([0-9a-f]{1,4})/iu);
  if (unicode) {
    return {
      value: decodeAnsiCodePoint(unicode[1], 16, escaped),
      endIndex: slashIndex + unicode[0].length,
    };
  }
  const longUnicode = numeric.match(/^U([0-9a-f]{1,8})/u);
  if (longUnicode) {
    return {
      value: decodeAnsiCodePoint(longUnicode[1], 16, escaped),
      endIndex: slashIndex + longUnicode[0].length,
    };
  }
  const octal = numeric.match(/^([0-7]{1,3})/u);
  if (octal) {
    return {
      value: decodeAnsiCodePoint(octal[1], 8, escaped),
      endIndex: slashIndex + octal[0].length,
    };
  }
  return { value: escaped, endIndex: slashIndex + 1 };
}

function tokenizeShellScript(script: string): ShellToken[] {
  const tokens: ShellToken[] = [];
  let word = '';
  let quote: 'single' | 'double' | 'ansi_c' | null = null;
  let comment = false;
  const flushWord = (): void => {
    if (!word) return;
    tokens.push({ kind: 'word', value: word });
    word = '';
  };

  for (let index = 0; index < script.length; index += 1) {
    const char = script[index];
    if (comment) {
      if (char === '\n' || char === '\r') {
        comment = false;
        tokens.push({ kind: 'separator' });
      }
      continue;
    }
    if (quote === 'single') {
      if (char === "'") quote = null;
      else word += char;
      continue;
    }
    if (quote === 'ansi_c') {
      if (char === "'") quote = null;
      else if (char === '\\') {
        const decoded = consumeAnsiEscape(script, index);
        word += decoded.value;
        index = decoded.endIndex;
      } else word += char;
      continue;
    }
    if (quote === 'double') {
      if (char === '"') quote = null;
      else if (char === '\\' && index + 1 < script.length) word += script[++index];
      else {
        const nested = consumeCommandSubstitution(script, index)
          ?? consumeBacktickSubstitution(script, index);
        if (nested) {
          tokens.push({ kind: 'nested_script', value: nested.script });
          word += '$()';
          index = nested.endIndex;
        } else word += char;
      }
      continue;
    }
    if (char === '$' && script[index + 1] === "'") {
      quote = 'ansi_c';
      index += 1;
      continue;
    }
    const nested = consumeCommandSubstitution(script, index)
      ?? consumeBacktickSubstitution(script, index);
    if (nested) {
      tokens.push({ kind: 'nested_script', value: nested.script });
      word += '$()';
      index = nested.endIndex;
      continue;
    }
    if (char === "'") {
      quote = 'single';
      continue;
    }
    if (char === '"') {
      quote = 'double';
      continue;
    }
    if (char === '\\' && index + 1 < script.length) {
      word += script[++index];
      continue;
    }
    if (char === '#' && word.length === 0) {
      comment = true;
      continue;
    }
    if (char === '\n' || char === '\r') {
      flushWord();
      tokens.push({ kind: 'separator' });
      continue;
    }
    if (/\s/u.test(char)) {
      flushWord();
      continue;
    }
    if (char === '&' && script[index + 1] === '>') {
      flushWord();
      index += script[index + 2] === '>' ? 2 : 1;
      tokens.push({ kind: 'output_redirect' });
      continue;
    }
    if (char === '>') {
      flushWord();
      if (script[index + 1] === '>'
        || script[index + 1] === '|'
        || script[index + 1] === '&') index += 1;
      tokens.push({ kind: 'output_redirect' });
      continue;
    }
    if (char === '<') {
      flushWord();
      if (script[index + 1] === '>') {
        index += 1;
        tokens.push({ kind: 'output_redirect' });
        continue;
      }
      while (script[index + 1] === '<') index += 1;
      if (script[index + 1] === '&') index += 1;
      tokens.push({ kind: 'input_redirect' });
      continue;
    }
    if (char === ';' || char === '|' || char === '&'
      || char === '(' || char === ')' || char === '{' || char === '}') {
      flushWord();
      if ((char === '|' || char === '&')
        && (script[index + 1] === char || script[index + 1] === '&')) index += 1;
      tokens.push({ kind: 'separator' });
      continue;
    }
    word += char;
  }
  flushWord();
  return tokens;
}

const SHELL_CONTROL_WORDS: ReadonlySet<string> = new Set([
  '!', 'if', 'then', 'elif', 'else', 'while', 'until', 'do', 'time',
]);

function normalizeCommandWords(input: readonly string[]): string[] {
  const words = [...input];
  for (;;) {
    if (words.length === 0) return words;
    const first = words[0];
    if (SHELL_CONTROL_WORDS.has(first) || /^[A-Za-z_][A-Za-z0-9_]*=/u.test(first)) {
      words.shift();
      continue;
    }
    const command = basename(first).toLowerCase();
    if (command === 'command' || command === 'builtin' || command === 'exec') {
      words.shift();
      while (words[0]?.startsWith('-')) words.shift();
      continue;
    }
    if (command === 'env') {
      words.shift();
      while (words[0]?.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/u.test(words[0] ?? '')) {
        words.shift();
      }
      continue;
    }
    return words;
  }
}

function resolveNestedShellScript(commandValue: string, args: readonly string[]): string | null {
  const command = basename(commandValue).toLowerCase();
  if (command === 'eval') return args.join(' ');
  if (command !== 'bash' && command !== 'sh' && command !== 'dash') return null;
  const commandIndex = args.findIndex(arg => /^-[A-Za-z]*c[A-Za-z]*$/u.test(arg));
  return commandIndex >= 0 && typeof args[commandIndex + 1] === 'string'
    ? args[commandIndex + 1]
    : null;
}

function resolveTargetPath(rawPath: string, cwd: string): string | null {
  const trimmed = rawPath.trim();
  if (!trimmed || trimmed.includes('\0') || trimmed.includes('$')) return null;
  return isAbsolute(trimmed) ? resolve(trimmed) : resolve(cwd, trimmed);
}

function positionalArgs(args: readonly string[]): string[] {
  const positional: string[] = [];
  let optionsEnded = false;
  for (const arg of args) {
    if (!optionsEnded && arg === '--') {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && arg.startsWith('-')) continue;
    positional.push(arg);
  }
  return positional;
}

function resolvedTargets(
  values: readonly string[],
  cwd: string,
  includeOwnerContainers: boolean,
): ShellMutationTarget[] {
  return values.flatMap((value) => {
    const path = resolveTargetPath(value, cwd);
    return path ? [{ path, includeOwnerContainers }] : [];
  });
}

function collectCommandMutationTargets(
  commandValue: string,
  args: readonly string[],
  cwd: string,
): ShellMutationTarget[] {
  const command = basename(commandValue).toLowerCase();
  const positional = positionalArgs(args);
  switch (command) {
    case 'rm':
    case 'unlink':
    case 'rmdir':
      return resolvedTargets(positional, cwd, true);
    case 'mv':
    case 'ln':
      return resolvedTargets(positional, cwd, true);
    case 'cp':
    case 'install':
      return resolvedTargets(positional.length > 0 ? [positional.at(-1)!] : [], cwd, true);
    case 'tee':
    case 'touch':
      return resolvedTargets(positional, cwd, false);
    case 'truncate':
      return resolvedTargets(positional.length > 0 ? [positional.at(-1)!] : [], cwd, false);
    case 'sed':
      return args.some(arg => arg === '-i' || arg.startsWith('-i'))
        ? resolvedTargets(positional.length > 1 ? positional.slice(1) : [], cwd, false)
        : [];
    case 'dd':
      return resolvedTargets(
        args.filter(arg => arg.startsWith('of=')).map(arg => arg.slice('of='.length)),
        cwd,
        false,
      );
    default:
      return [];
  }
}

function collectScriptMutationTargets(script: string, cwd: string): ShellMutationTarget[] {
  const targets: ShellMutationTarget[] = [];
  const pendingScripts = [script];
  const seenScripts = new Set(pendingScripts);
  const queueScript = (nestedScript: string): void => {
    if (!seenScripts.has(nestedScript)) {
      seenScripts.add(nestedScript);
      pendingScripts.push(nestedScript);
    }
  };
  for (let scriptIndex = 0; scriptIndex < pendingScripts.length; scriptIndex += 1) {
    let words: string[] = [];
    let awaitingRedirect: 'output' | 'input' | null = null;
    const flushCommand = (): void => {
      const normalizedWords = normalizeCommandWords(words);
      words = [];
      if (normalizedWords.length === 0) return;
      targets.push(...collectCommandMutationTargets(
        normalizedWords[0],
        normalizedWords.slice(1),
        cwd,
      ));
      const nestedScript = resolveNestedShellScript(normalizedWords[0], normalizedWords.slice(1));
      if (nestedScript !== null) queueScript(nestedScript);
    };

    for (const token of tokenizeShellScript(pendingScripts[scriptIndex])) {
      if (token.kind === 'separator') {
        flushCommand();
        awaitingRedirect = null;
        continue;
      }
      if (token.kind === 'nested_script') {
        queueScript(token.value);
        continue;
      }
      if (token.kind === 'output_redirect') {
        awaitingRedirect = 'output';
        continue;
      }
      if (token.kind === 'input_redirect') {
        awaitingRedirect = 'input';
        continue;
      }
      if (awaitingRedirect) {
        if (awaitingRedirect === 'output') {
          targets.push(...resolvedTargets([token.value], cwd, false));
        }
        awaitingRedirect = null;
        continue;
      }
      words.push(token.value);
    }
    flushCommand();
  }
  return targets;
}

export function collectShellMutationTargets(
  params: ShellExecParams,
  workspacePath: string,
): ShellMutationTarget[] {
  const requestedCwd = typeof params.cwd === 'string' && params.cwd.trim()
    ? params.cwd.trim()
    : workspacePath;
  const cwd = isAbsolute(requestedCwd) ? resolve(requestedCwd) : resolve(workspacePath, requestedCwd);
  const args = Array.isArray(params.args) ? params.args : [];
  const commandWords = normalizeCommandWords([params.command, ...args]);
  if (commandWords.length === 0) return [];
  const nestedScript = resolveNestedShellScript(commandWords[0], commandWords.slice(1));
  if (nestedScript !== null) return collectScriptMutationTargets(nestedScript, cwd);
  return collectCommandMutationTargets(commandWords[0], commandWords.slice(1), cwd);
}
