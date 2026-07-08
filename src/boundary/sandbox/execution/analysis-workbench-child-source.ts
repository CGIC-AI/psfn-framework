export const ANALYSIS_WORKBENCH_CHILD_PROTOCOL = 'analysis-workbench-child-v1';

export const ANALYSIS_WORKBENCH_CHILD_SOURCE = String.raw`
import vm from 'node:vm';

const PROTOCOL = 'analysis-workbench-child-v1';
const MAX_IPC_DEPTH = 20;
const MAX_IPC_ARRAY_LENGTH = 10000;
const MAX_IPC_OBJECT_KEYS = 2000;
const DANGEROUS_KEYS = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);
const BLOCKED_GLOBAL_NAMES = [
  'process',
  'require',
  'module',
  'exports',
  'Buffer',
  'fetch',
  'WebSocket',
  'XMLHttpRequest',
  'navigator',
  'Deno',
  'Bun',
  'Worker',
  'SharedWorker',
  'MessageChannel',
  'MessagePort',
  'importScripts',
];
const PURE_HELPER_NAMES = [
  'search',
  'grep',
  'grep_v',
  'between',
  'head',
  'tail',
  'word_frequency',
  'diff',
  'text_similarity',
  'dedupe',
  'group_by',
  'partition',
];
const BUILTIN_NAMES = new Set([
  'print',
  'console',
  'FINAL',
  'globalThis',
  'JSON',
  'Math',
  'Date',
  'Array',
  'Object',
  'String',
  'Number',
  'Boolean',
  'Map',
  'Set',
  'RegExp',
  'Promise',
  'parseInt',
  'parseFloat',
  'isNaN',
  'isFinite',
  'undefined',
  'null',
  'true',
  'false',
  'Infinity',
  'NaN',
  'setTimeout',
  'eval',
  'Function',
  ...BLOCKED_GLOBAL_NAMES,
  ...PURE_HELPER_NAMES,
]);

const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
  'before', 'after', 'above', 'below', 'between', 'and', 'but', 'or',
  'nor', 'not', 'so', 'yet', 'both', 'either', 'neither', 'each',
  'every', 'all', 'any', 'few', 'more', 'most', 'other', 'some', 'such',
  'no', 'only', 'own', 'same', 'than', 'too', 'very', 'just', 'because',
  'if', 'when', 'while', 'how', 'what', 'which', 'who', 'whom', 'where',
  'why', 'that', 'this', 'these', 'those', 'i', 'me', 'my', 'we', 'our',
  'you', 'your', 'he', 'him', 'his', 'she', 'her', 'it', 'its', 'they',
  'them', 'their',
]);

const pendingHostCalls = new Map();
const activeHostCallPromises = new Set();
let nextHostCallId = 1;

function tryRegex(pattern) {
  try {
    return new RegExp(pattern);
  } catch {
    return null;
  }
}

function search(text, pattern, contextLines = 0) {
  const re = tryRegex(String(pattern));
  if (!re) return [];
  const lines = String(text).split('\n');
  const matchIndices = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (re.test(lines[i])) matchIndices.push(i);
  }
  if (matchIndices.length === 0) return [];
  const blocks = [];
  for (const idx of matchIndices) {
    const start = Math.max(0, idx - contextLines);
    const end = Math.min(lines.length - 1, idx + contextLines);
    blocks.push(lines.slice(start, end + 1).join('\n'));
  }
  return blocks;
}

function grep(text, pattern) {
  const re = tryRegex(String(pattern));
  if (!re) return '';
  return String(text).split('\n').filter(line => re.test(line)).join('\n');
}

function grep_v(text, pattern) {
  const re = tryRegex(String(pattern));
  if (!re) return '';
  return String(text).split('\n').filter(line => !re.test(line)).join('\n');
}

function between(text, start, end) {
  const source = String(text);
  const startValue = String(start);
  const endValue = String(end);
  const startIdx = source.indexOf(startValue);
  if (startIdx === -1) return '';
  const afterStart = startIdx + startValue.length;
  const endIdx = source.indexOf(endValue, afterStart);
  if (endIdx === -1) return '';
  return source.slice(afterStart, endIdx);
}

function head(text, n = 10) {
  return String(text).split('\n').slice(0, n).join('\n');
}

function tail(text, n = 10) {
  const lines = String(text).split('\n');
  return lines.slice(Math.max(0, lines.length - n)).join('\n');
}

function word_frequency(text) {
  const counts = {};
  const words = String(text).toLowerCase().match(/[a-z]+/g);
  if (!words) return counts;
  for (const word of words) {
    if (!STOPWORDS.has(word)) {
      counts[word] = (counts[word] || 0) + 1;
    }
  }
  return counts;
}

function diff(a, b) {
  const aLines = new Set(String(a).split('\n'));
  const bLines = new Set(String(b).split('\n'));
  const result = [];
  for (const line of aLines) {
    if (!bLines.has(line)) result.push('-' + line);
  }
  for (const line of bLines) {
    if (!aLines.has(line)) result.push('+' + line);
  }
  return result.join('\n');
}

function text_similarity(a, b) {
  const wordsA = new Set(String(a).toLowerCase().match(/[a-z]+/g) || []);
  const wordsB = new Set(String(b).toLowerCase().match(/[a-z]+/g) || []);
  if (wordsA.size === 0 && wordsB.size === 0) return 0;
  let intersection = 0;
  for (const word of wordsA) {
    if (wordsB.has(word)) intersection += 1;
  }
  const union = wordsA.size + wordsB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function dedupe(arr, key) {
  if (!Array.isArray(arr) || typeof key !== 'function') return [];
  const seen = new Set();
  const result = [];
  for (const item of arr) {
    const value = String(key(item));
    if (!seen.has(value)) {
      seen.add(value);
      result.push(item);
    }
  }
  return result;
}

function group_by(arr, key) {
  const groups = {};
  if (!Array.isArray(arr) || typeof key !== 'function') return groups;
  for (const item of arr) {
    const value = String(key(item));
    if (!groups[value]) groups[value] = [];
    groups[value].push(item);
  }
  return groups;
}

function partition(arr, pred) {
  const truthy = [];
  const falsy = [];
  if (!Array.isArray(arr) || typeof pred !== 'function') return [truthy, falsy];
  for (const item of arr) {
    if (pred(item)) truthy.push(item);
    else falsy.push(item);
  }
  return [truthy, falsy];
}

const PURE_HELPERS = {
  search,
  grep,
  grep_v,
  between,
  head,
  tail,
  word_frequency,
  diff,
  text_similarity,
  dedupe,
  group_by,
  partition,
};

function isPlainObject(value) {
  if (!value || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function sanitizeForIpc(value, depth = 0, seen = new WeakSet()) {
  if (value === null || value === undefined) return value;
  const valueType = typeof value;
  if (valueType === 'string' || valueType === 'number' || valueType === 'boolean') return value;
  if (valueType === 'bigint') return value.toString();
  if (valueType === 'symbol') return String(value);
  if (valueType === 'function') return '[Function' + (value.name ? ': ' + value.name : '') + ']';
  if (valueType !== 'object') return String(value);
  if (seen.has(value)) return '[Circular]';
  if (depth >= MAX_IPC_DEPTH) return '[MaxDepth]';
  seen.add(value);

  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_IPC_ARRAY_LENGTH)
      .map(item => sanitizeForIpc(item, depth + 1, seen));
  }
  if (value instanceof Map) {
    return sanitizeForIpc(Object.fromEntries(value), depth + 1, seen);
  }
  if (value instanceof Set) {
    return sanitizeForIpc([...value], depth + 1, seen);
  }

  const output = {};
  const keys = Object.keys(value).slice(0, MAX_IPC_OBJECT_KEYS);
  for (const key of keys) {
    if (DANGEROUS_KEYS.has(key)) continue;
    output[key] = sanitizeForIpc(value[key], depth + 1, seen);
  }
  if (!isPlainObject(value) && Object.keys(output).length === 0) {
    return String(value);
  }
  return output;
}

function formatPrintValue(value) {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(sanitizeForIpc(value), null, 2);
  } catch {
    return String(value);
  }
}

function sendDebugLog(message, key, details) {
  if (typeof process.send !== 'function' || process.connected === false) return;
  process.send({
    type: 'sandbox_debug_log',
    protocol: PROTOCOL,
    message,
    key,
    details: sanitizeForIpc(details),
  }, (error) => {
    if (!error) return;
    process.stderr.write('[analysis-workbench-child] failed to emit debug log: ' + toErrorMessage(error) + '\n');
  });
}

function createHostHelper(name) {
  return (...args) => {
    if (typeof process.send !== 'function') {
      return Promise.reject(new Error('sandbox IPC unavailable'));
    }

    const id = nextHostCallId;
    nextHostCallId += 1;
    const promise = new Promise((resolve, reject) => {
      pendingHostCalls.set(id, { resolve, reject });
      process.send({
        type: 'sandbox_helper_call',
        protocol: PROTOCOL,
        id,
        name,
        args: sanitizeForIpc(args),
      }, (error) => {
        if (!error) return;
        pendingHostCalls.delete(id);
        reject(error);
      });
    });
    activeHostCallPromises.add(promise);
    promise.then(
      () => activeHostCallPromises.delete(promise),
      () => activeHostCallPromises.delete(promise),
    );
    promise.catch((error) => {
      const errorMessage = toErrorMessage(error);
      sendDebugLog(
        'Analysis workbench sandbox host helper promise rejected',
        'analysis_workbench.host_helper_rejection:' + name + ':' + errorMessage,
        {
          helperName: name,
          callId: id,
          error: errorMessage,
        },
      );
    });
    return promise;
  };
}

function isFinalAnswerSignal(error) {
  return Boolean(error && typeof error === 'object' && error.__analysisWorkbenchFinalAnswer === true);
}

function toErrorMessage(error) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && typeof error.message === 'string') return error.message;
  return String(error);
}

function assertMemoryCeiling(memoryCeilingBytes) {
  if (!Number.isFinite(memoryCeilingBytes) || memoryCeilingBytes <= 0) return;
  const heapUsedBytes = process.memoryUsage().heapUsed;
  if (heapUsedBytes > memoryCeilingBytes) {
    const usedMb = (heapUsedBytes / (1024 * 1024)).toFixed(1);
    const limitMb = (memoryCeilingBytes / (1024 * 1024)).toFixed(1);
    throw new Error('Sandbox memory ceiling exceeded (' + usedMb + 'MB > ' + limitMb + 'MB)');
  }
}

function restoreLocals(context, locals) {
  if (!locals || typeof locals !== 'object') return;
  for (const [key, value] of Object.entries(locals)) {
    if (BUILTIN_NAMES.has(key) || DANGEROUS_KEYS.has(key)) continue;
    context[key] = sanitizeForIpc(value);
  }
}

function collectLocals(context, helperNames) {
  const helpers = new Set(helperNames);
  const locals = {};
  for (const key of Object.getOwnPropertyNames(context)) {
    if (BUILTIN_NAMES.has(key) || helpers.has(key) || DANGEROUS_KEYS.has(key)) continue;
    locals[key] = sanitizeForIpc(context[key]);
  }
  return locals;
}

function sendAndExit(message, exitCode = 0) {
  if (typeof process.send !== 'function') {
    process.exit(exitCode);
    return;
  }
  process.send(message, () => {
    process.exit(exitCode);
  });
}

async function executeSandbox(message) {
  const output = [];
  const pendingPrints = new Set();
  const helperNames = Array.isArray(message.helperNames)
    ? message.helperNames.filter(name => typeof name === 'string')
    : [];
  const recordOutput = (...args) => {
    const index = output.length;
    output.push('');
    const pending = Promise.all(args.map(async (arg) => {
      try {
        return formatPrintValue(await Promise.resolve(arg));
      } catch (error) {
        return '[Promise rejected: ' + toErrorMessage(error) + ']';
      }
    })).then((values) => {
      output[index] = values.join(' ');
    });
    pendingPrints.add(pending);
    pending.then(
      () => pendingPrints.delete(pending),
      () => pendingPrints.delete(pending),
    );
  };
  const waitForPendingWork = async () => {
    await Promise.allSettled([...activeHostCallPromises]);
    await Promise.allSettled([...pendingPrints]);
  };
  const contextValues = {
    print: recordOutput,
    console: {
      log: recordOutput,
      warn: recordOutput,
      error: recordOutput,
    },
    FINAL: (answer) => {
      throw {
        __analysisWorkbenchFinalAnswer: true,
        answer: String(answer),
      };
    },
    JSON,
    Math,
    Date,
    Array,
    Object,
    String,
    Number,
    Boolean,
    Map,
    Set,
    RegExp,
    Promise,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    undefined,
    null: null,
    true: true,
    false: false,
    Infinity,
    NaN,
    setTimeout,
    eval: undefined,
    Function: undefined,
    ...Object.fromEntries(BLOCKED_GLOBAL_NAMES.map(name => [name, undefined])),
    ...PURE_HELPERS,
  };

  for (const name of helperNames) {
    if (BUILTIN_NAMES.has(name) || DANGEROUS_KEYS.has(name)) continue;
    contextValues[name] = createHostHelper(name);
  }

  const context = vm.createContext(contextValues, {
    codeGeneration: {
      strings: false,
      wasm: false,
    },
  });
  context.globalThis = context;
  restoreLocals(context, message.initialLocals);

  let memoryGuard;
  let timeoutHandle;
  try {
    assertMemoryCeiling(message.memoryCeilingBytes);
    const script = new vm.Script(String(message.code), {
      filename: 'analysis-workbench-repl.js',
    });
    const execution = Promise.resolve(script.runInContext(context, {
      timeout: message.timeoutMs,
      breakOnSigint: false,
    }));
    const timeout = new Promise((resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(new Error('Execution timed out after ' + message.timeoutMs + 'ms'));
      }, message.timeoutMs);
      if (timeoutHandle && typeof timeoutHandle.unref === 'function') {
        timeoutHandle.unref();
      }
    });
    const memory = new Promise((resolve, reject) => {
      if (!Number.isFinite(message.memoryCeilingBytes) || message.memoryCeilingBytes <= 0) return;
      memoryGuard = setInterval(() => {
        try {
          assertMemoryCeiling(message.memoryCeilingBytes);
        } catch (error) {
          reject(error);
        }
      }, 20);
      if (memoryGuard && typeof memoryGuard.unref === 'function') {
        memoryGuard.unref();
      }
    });

    await Promise.race([execution, timeout, memory]);
    assertMemoryCeiling(message.memoryCeilingBytes);
    await waitForPendingWork();
    sendAndExit({
      type: 'sandbox_result',
      protocol: PROTOCOL,
      output,
      error: null,
      finalAnswer: null,
      locals: collectLocals(context, helperNames),
    });
  } catch (error) {
    await waitForPendingWork();
    sendAndExit({
      type: 'sandbox_result',
      protocol: PROTOCOL,
      output,
      error: isFinalAnswerSignal(error) ? null : toErrorMessage(error),
      finalAnswer: isFinalAnswerSignal(error) ? String(error.answer) : null,
      locals: collectLocals(context, helperNames),
    });
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (memoryGuard) clearInterval(memoryGuard);
  }
}

process.on('message', (message) => {
  if (!message || typeof message !== 'object') return;
  if (message.type === 'sandbox_helper_result') {
    const pending = pendingHostCalls.get(message.id);
    if (!pending) return;
    pendingHostCalls.delete(message.id);
    if (message.ok) pending.resolve(message.value);
    else pending.reject(new Error(String(message.error || 'sandbox helper failed')));
    return;
  }

  if (message.type !== 'sandbox_execute' || message.protocol !== PROTOCOL) return;
  void executeSandbox(message);
});
`;
