#!/usr/bin/env node
/*
Usage:
  node scripts/ops/openrouter-toolcall-eval.mjs --model z-ai/glm-5.2 [options]

Options:
  --model ID             OpenRouter model id, for example z-ai/glm-5.2
  --trials N             Trials per provider tag (default: 5)
  --providers LIST       Comma-separated provider tag substring filters
  --no-reasoning         Omit OpenRouter reasoning:{enabled:true}
  --no-pin               Skip endpoint enumeration and provider pinning; let the router choose (for :exacto / auto-routing evals)
  --force-tool           Force tool_choice to the journal function (narrows provider pool; default is auto like production)
  --long-context         Add deterministic filler dialogue before the tool-call prompt
  --concurrency N        Providers to evaluate in parallel (default: 3)
  --json PATH            Write full per-trial records and machine summary
  --timeout-s N          Per-request timeout in seconds (default: 90)
  -h, --help             Show this help
*/

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_TRIALS = 5;
const DEFAULT_CONCURRENCY = 3;
const DEFAULT_TIMEOUT_SECONDS = 90;
const DEFAULT_MAX_TOKENS = 600;
const LONG_CONTEXT_MAX_TOKENS = 1_200;
const TOOL_ACTIONS = new Set(['list', 'read', 'write', 'search']);
const RETRYABLE_429_RETRIES = 2;
const ARG_PREVIEW_CHARS = 120;

const JOURNAL_TOOL = {
  type: 'function',
  function: {
    name: 'journal',
    description: 'Access the user journal. Use list to enumerate entries, read to open an entry, write to save content, and search to query entries.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'read', 'write', 'search'],
        },
        path: {
          type: 'string',
        },
        content: {
          type: 'string',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
};

const CLASSIFICATIONS = {
  OK: 'OK',
  EMPTY_ARGS: 'EMPTY_ARGS',
  BAD_JSON: 'BAD_JSON',
  WRONG_SHAPE: 'WRONG_SHAPE',
  NO_TOOL_CALL: 'NO_TOOL_CALL',
  HTTP_ERROR: 'HTTP_ERROR',
  TIMEOUT: 'TIMEOUT',
  SKIPPED_404: 'SKIPPED_404',
};

function usage() {
  console.log(`Usage: node scripts/ops/openrouter-toolcall-eval.mjs --model z-ai/glm-5.2 [options]

Options:
  --model ID             OpenRouter model id, for example z-ai/glm-5.2
  --trials N             Trials per provider tag (default: ${DEFAULT_TRIALS})
  --providers LIST       Comma-separated provider tag substring filters
  --no-reasoning         Omit OpenRouter reasoning:{enabled:true}
  --no-pin               Skip endpoint enumeration and provider pinning; let the router choose (for :exacto / auto-routing evals)
  --force-tool           Force tool_choice to the journal function (narrows provider pool; default is auto like production)
  --long-context         Add deterministic filler dialogue before the tool-call prompt
  --concurrency N        Providers to evaluate in parallel (default: ${DEFAULT_CONCURRENCY})
  --json PATH            Write full per-trial records and machine summary
  --timeout-s N          Per-request timeout in seconds (default: ${DEFAULT_TIMEOUT_SECONDS})
  -h, --help             Show this help`);
}

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function parsePositiveInt(value, flagName) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || String(parsed) !== String(value).trim()) {
    throw new Error(`${flagName} must be a positive integer, got: ${value}`);
  }
  return parsed;
}

function ensureArgValue(argv, index, flagName) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flagName} requires a value`);
  }
  return value;
}

function parseArgs(argv) {
  const config = {
    model: '',
    trials: DEFAULT_TRIALS,
    providerFilters: [],
    reasoningEnabled: true,
    longContext: false,
    concurrency: DEFAULT_CONCURRENCY,
    jsonPath: '',
    timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
    noPin: false,
    forceTool: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '-h':
      case '--help':
        config.help = true;
        break;
      case '--model':
        config.model = trimString(ensureArgValue(argv, index, arg));
        index += 1;
        break;
      case '--trials':
        config.trials = parsePositiveInt(ensureArgValue(argv, index, arg), arg);
        index += 1;
        break;
      case '--providers':
        config.providerFilters = ensureArgValue(argv, index, arg)
          .split(',')
          .map(value => trimString(value).toLowerCase())
          .filter(Boolean);
        index += 1;
        break;
      case '--no-reasoning':
        config.reasoningEnabled = false;
        break;
      case '--no-pin':
        config.noPin = true;
        break;
      case '--force-tool':
        config.forceTool = true;
        break;
      case '--long-context':
        config.longContext = true;
        break;
      case '--concurrency':
        config.concurrency = parsePositiveInt(ensureArgValue(argv, index, arg), arg);
        index += 1;
        break;
      case '--json':
        config.jsonPath = trimString(ensureArgValue(argv, index, arg));
        index += 1;
        break;
      case '--timeout-s':
        config.timeoutSeconds = parsePositiveInt(ensureArgValue(argv, index, arg), arg);
        index += 1;
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (!config.help && !config.model) {
    throw new Error('--model is required');
  }

  return config;
}

function modelToEndpointPath(model) {
  return model.split('/').map(segment => encodeURIComponent(segment)).join('/');
}

function readStringAtPath(value, paths) {
  for (const path of paths) {
    let current = value;
    for (const key of path) {
      if (!current || typeof current !== 'object') {
        current = undefined;
        break;
      }
      current = current[key];
    }
    const text = trimString(current);
    if (text) return text;
  }
  return '';
}

function readPositiveIntAtPath(value, paths) {
  for (const path of paths) {
    let current = value;
    for (const key of path) {
      if (!current || typeof current !== 'object') {
        current = undefined;
        break;
      }
      current = current[key];
    }
    const parsed = Number.parseInt(String(current), 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

function statusToString(status) {
  if (status === undefined || status === null) return '';
  if (typeof status === 'string') return status;
  if (typeof status === 'number' || typeof status === 'boolean') return String(status);
  try {
    return JSON.stringify(status);
  } catch {
    return String(status);
  }
}

function isNegativeStatus(status) {
  if (typeof status === 'number') return status < 0;
  const text = statusToString(status).toLowerCase();
  if (!text) return false;
  return ['down', 'offline', 'disabled', 'error', 'errored', 'unavailable', 'negative'].some(value => text.includes(value));
}

function extractEndpointArray(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  if (Array.isArray(payload.endpoints)) return payload.endpoints;
  if (Array.isArray(payload.data?.endpoints)) return payload.data.endpoints;
  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload.model?.endpoints)) return payload.model.endpoints;
  return [];
}

function normalizeEndpoint(rawEndpoint, index, fallbackContextLength) {
  const providerName = readStringAtPath(rawEndpoint, [
    ['provider_name'],
    ['providerName'],
    ['provider', 'name'],
    ['provider', 'provider_name'],
    ['name'],
    ['provider'],
  ]);
  const explicitTag = readStringAtPath(rawEndpoint, [
    ['tag'],
    ['provider_tag'],
    ['providerTag'],
    ['provider', 'tag'],
    ['slug'],
    ['id'],
  ]);
  const tag = explicitTag || providerName || `endpoint-${index + 1}`;
  const quantization = readStringAtPath(rawEndpoint, [
    ['quantization'],
    ['quantization_config'],
    ['provider', 'quantization'],
    ['metadata', 'quantization'],
  ]);
  const contextLength = readPositiveIntAtPath(rawEndpoint, [
    ['context_length'],
    ['contextLength'],
    ['max_context_length'],
    ['maxContextLength'],
    ['provider', 'context_length'],
    ['provider', 'contextLength'],
  ]) ?? fallbackContextLength;

  return {
    index,
    providerName,
    tag,
    tagWasFallback: !explicitTag,
    status: rawEndpoint?.status,
    statusText: statusToString(rawEndpoint?.status),
    quantization,
    contextLength,
    raw: rawEndpoint,
  };
}

function endpointMatchesFilters(endpoint, filters) {
  if (filters.length === 0) return true;
  const tag = endpoint.tag.toLowerCase();
  return filters.some(filter => tag.includes(filter));
}

function normalizeEndpoints(payload, filters) {
  const modelContextLength = readPositiveIntAtPath(payload, [
    ['context_length'],
    ['contextLength'],
    ['max_context_length'],
    ['maxContextLength'],
    ['data', 'context_length'],
    ['data', 'contextLength'],
    ['data', 'max_context_length'],
    ['data', 'maxContextLength'],
  ]);
  const endpoints = extractEndpointArray(payload)
    .map((rawEndpoint, index) => normalizeEndpoint(rawEndpoint, index, modelContextLength));
  const runnable = [];
  const skipped = [];

  for (const endpoint of endpoints) {
    if (!endpointMatchesFilters(endpoint, filters)) {
      skipped.push({
        ...endpoint,
        skipReason: 'FILTERED_BY_PROVIDERS',
      });
      continue;
    }
    if (isNegativeStatus(endpoint.status)) {
      skipped.push({
        ...endpoint,
        skipReason: 'NEGATIVE_STATUS',
      });
      continue;
    }
    runnable.push(endpoint);
  }

  return {
    endpoints,
    runnable,
    skipped,
  };
}

async function readResponseText(response) {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function truncateText(value, limit) {
  const text = trimString(value).replace(/\s+/g, ' ');
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 3))}...`;
}

async function fetchJsonWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchModelEndpoints(config, apiKey) {
  const url = `${OPENROUTER_BASE_URL}/models/${modelToEndpointPath(config.model)}/endpoints`;
  let response;
  try {
    response = await fetchJsonWithTimeout(url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
    }, config.timeoutSeconds * 1_000);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`OpenRouter endpoints request failed before a response: ${message}`);
  }

  if (!response.ok) {
    const body = truncateText(await readResponseText(response), 500);
    throw new Error(`OpenRouter endpoints request failed: HTTP ${response.status}${body ? `: ${body}` : ''}`);
  }

  try {
    return await response.json();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`OpenRouter endpoints response was not valid JSON: ${message}`);
  }
}

function estimateTokensForText(text) {
  return Math.ceil(String(text).length / 4);
}

function estimateMessagesTokens(messages) {
  let tokens = 0;
  for (const message of messages) {
    tokens += 4;
    tokens += estimateTokensForText(message.role);
    tokens += estimateTokensForText(message.content);
  }
  return tokens + 4;
}

const FILLER_TOPICS = [
  'morning routines and calendar friction',
  'books started but not finished',
  'ideas for improving focus during deep work',
  'small repairs around the apartment',
  'meals that were easy to cook after a long day',
  'memories of useful conversations with friends',
  'planning notes for weekend errands',
  'observations about sleep and caffeine',
  'gratitude notes that still sound specific',
  'questions to ask during the next project review',
  'travel logistics and packing reminders',
  'draft titles for future journal entries',
  'places where a decision felt reversible',
  'notes about what made yesterday calmer',
  'a short inventory of unfinished chores',
  'reflections on reading, music, and attention',
];

function makeFillerPair(index) {
  const topic = FILLER_TOPICS[index % FILLER_TOPICS.length];
  const day = String((index % 28) + 1).padStart(2, '0');
  const month = String((Math.floor(index / 28) % 12) + 1).padStart(2, '0');
  return [
    {
      role: 'user',
      content: `Background journal discussion ${index + 1} from 2026-${month}-${day}: I am thinking about ${topic}. Please reflect conversationally and do not use tools for this background note. Include concrete but ordinary details so this feels like past chat history, not instructions for the current request.`,
    },
    {
      role: 'assistant',
      content: `Background reflection ${index + 1}: The note about ${topic} sounds like something that could become a concise journal entry later. I would keep the entry grounded in dates, people, places, and one next action. No journal lookup is needed for this older background exchange, and the current task has not started yet.`,
    },
  ];
}

function longContextTargetTokens(endpoint) {
  const contextLength = endpoint.contextLength;
  if (!contextLength) return 16_000;
  const budget = Math.max(1_000, contextLength - LONG_CONTEXT_MAX_TOKENS - 1_000);
  return Math.min(16_000, Math.max(3_000, Math.floor(budget * 0.7)));
}

function buildMessages(config, endpoint) {
  const messages = [
    {
      role: 'system',
      content: 'Use tools when asked.',
    },
  ];

  const targetTokens = config.longContext ? longContextTargetTokens(endpoint) : null;
  if (targetTokens) {
    let pairIndex = 0;
    while (estimateMessagesTokens(messages) < targetTokens) {
      messages.push(...makeFillerPair(pairIndex));
      pairIndex += 1;
    }
  }

  messages.push({
    role: 'user',
    content: 'Think briefly about what my journal might contain, then list my journal entries using the journal tool.',
  });

  return {
    messages,
    approxPromptTokens: estimateMessagesTokens(messages),
    longContextTargetTokens: targetTokens,
  };
}

function buildChatRequestBody(config, endpoint) {
  const prompt = buildMessages(config, endpoint);
  return {
    body: {
      model: config.model,
      stream: true,
      ...(config.noPin
        ? {}
        : {
            provider: {
              order: [endpoint.tag],
              allow_fallbacks: false,
            },
          }),
      ...(config.reasoningEnabled ? { reasoning: { enabled: true } } : {}),
      max_tokens: config.longContext ? LONG_CONTEXT_MAX_TOKENS : DEFAULT_MAX_TOKENS,
      messages: prompt.messages,
      tools: [JOURNAL_TOOL],
      // Default matches production (tool_choice auto). Forcing the function narrows
      // OpenRouter's provider pool to hosts supporting forced tool_choice, hiding
      // exactly the marginal hosts we want to measure.
      ...(config.forceTool
        ? {
            tool_choice: {
              type: 'function',
              function: {
                name: 'journal',
              },
            },
          }
        : { tool_choice: 'auto' }),
    },
    approxPromptTokens: prompt.approxPromptTokens,
    longContextTargetTokens: prompt.longContextTargetTokens,
  };
}

function isAbortError(error) {
  return error instanceof Error && error.name === 'AbortError';
}

function sleep(ms) {
  return new Promise(resolveSleep => {
    setTimeout(resolveSleep, ms);
  });
}

function providerValueToString(value) {
  if (typeof value === 'string') return trimString(value);
  if (!value || typeof value !== 'object') return '';
  const fromObject = readStringAtPath(value, [
    ['provider_name'],
    ['providerName'],
    ['name'],
    ['tag'],
    ['id'],
  ]);
  if (fromObject) return fromObject;
  try {
    return truncateText(JSON.stringify(value), 120);
  } catch {
    return String(value);
  }
}

function emptyStreamAccumulator() {
  return {
    providerNames: new Set(),
    reasoningBytes: 0,
    chunks: 0,
    toolCallsByIndex: new Map(),
  };
}

function ensureToolCall(accumulator, index) {
  const existing = accumulator.toolCallsByIndex.get(index);
  if (existing) return existing;
  const created = {
    index,
    id: '',
    type: '',
    functionName: '',
    arguments: '',
  };
  accumulator.toolCallsByIndex.set(index, created);
  return created;
}

function applyToolCallFragment(accumulator, toolCall, fallbackIndex) {
  if (!toolCall || typeof toolCall !== 'object') return;
  const index = typeof toolCall.index === 'number' ? toolCall.index : fallbackIndex;
  const current = ensureToolCall(accumulator, index);

  if (typeof toolCall.id === 'string' && toolCall.id && !current.id) {
    current.id = toolCall.id;
  }
  if (typeof toolCall.type === 'string' && toolCall.type && !current.type) {
    current.type = toolCall.type;
  }

  const fn = toolCall.function;
  if (fn && typeof fn === 'object') {
    if (typeof fn.name === 'string' && fn.name && !current.functionName) {
      current.functionName = fn.name;
    }
    if (typeof fn.arguments === 'string') {
      current.arguments += fn.arguments;
    }
  }
}

function applyChoiceDelta(accumulator, choice) {
  if (!choice || typeof choice !== 'object') return;
  const delta = choice.delta && typeof choice.delta === 'object'
    ? choice.delta
    : choice.message && typeof choice.message === 'object'
      ? choice.message
      : {};

  for (const key of ['reasoning', 'reasoning_content']) {
    const value = delta[key];
    if (typeof value === 'string') {
      accumulator.reasoningBytes += Buffer.byteLength(value, 'utf8');
    }
  }

  const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
  toolCalls.forEach((toolCall, index) => {
    applyToolCallFragment(accumulator, toolCall, index);
  });
}

function applySseChunk(accumulator, chunk) {
  if (!chunk || typeof chunk !== 'object') return;
  accumulator.chunks += 1;
  const providerName = providerValueToString(chunk.provider);
  if (providerName) accumulator.providerNames.add(providerName);

  const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
  for (const choice of choices) {
    applyChoiceDelta(accumulator, choice);
  }
}

async function readOpenRouterSse(response) {
  if (!response.body) {
    throw new Error('streaming response had no body');
  }

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  const accumulator = emptyStreamAccumulator();
  let buffer = '';
  let eventData = [];
  let done = false;

  function dispatchEvent() {
    if (eventData.length === 0) return;
    const data = eventData.join('\n');
    eventData = [];
    if (data.trim() === '[DONE]') {
      done = true;
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`failed to parse SSE JSON event: ${message}; data=${truncateText(data, 240)}`);
    }
    applySseChunk(accumulator, parsed);
  }

  function consumeLine(rawLine) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line === '') {
      dispatchEvent();
      return;
    }
    if (line.startsWith(':')) return;
    if (!line.startsWith('data:')) return;
    let data = line.slice('data:'.length);
    if (data.startsWith(' ')) data = data.slice(1);
    eventData.push(data);
  }

  while (!done) {
    const { done: readerDone, value } = await reader.read();
    if (readerDone) break;
    buffer += decoder.decode(value, { stream: true });
    let newlineIndex = buffer.search(/\r?\n/);
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex);
      const newlineLength = buffer[newlineIndex] === '\r' && buffer[newlineIndex + 1] === '\n' ? 2 : 1;
      buffer = buffer.slice(newlineIndex + newlineLength);
      consumeLine(line);
      if (done) break;
      newlineIndex = buffer.search(/\r?\n/);
    }
  }

  const tail = decoder.decode();
  if (tail) buffer += tail;
  if (!done && buffer) consumeLine(buffer);
  if (!done) dispatchEvent();

  return {
    providerNames: Array.from(accumulator.providerNames),
    reasoningBytes: accumulator.reasoningBytes,
    chunks: accumulator.chunks,
    toolCalls: Array.from(accumulator.toolCallsByIndex.values())
      .sort((left, right) => left.index - right.index),
  };
}

function classifyToolCallId(id) {
  if (!id) return 'missing';
  if (id.startsWith('call_')) return 'call_';
  if (id.startsWith('chatcmpl-tool-')) return 'chatcmpl-tool-';
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    return 'uuid';
  }
  return 'other';
}

function classifyToolCall(toolCalls) {
  if (toolCalls.length === 0) {
    return {
      classification: CLASSIFICATIONS.NO_TOOL_CALL,
      selectedToolCall: null,
      parsedArguments: null,
      parseError: '',
    };
  }

  const selectedToolCall = toolCalls.find(toolCall => toolCall.functionName === 'journal') ?? toolCalls[0];
  const argumentsRaw = selectedToolCall.arguments ?? '';
  const trimmed = argumentsRaw.trim();
  if (trimmed === '' || trimmed === '{}') {
    return {
      classification: CLASSIFICATIONS.EMPTY_ARGS,
      selectedToolCall,
      parsedArguments: null,
      parseError: '',
    };
  }

  let parsedArguments;
  try {
    parsedArguments = JSON.parse(argumentsRaw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      classification: CLASSIFICATIONS.BAD_JSON,
      selectedToolCall,
      parsedArguments: null,
      parseError: message,
    };
  }

  if (
    !parsedArguments
    || typeof parsedArguments !== 'object'
    || Array.isArray(parsedArguments)
    || typeof parsedArguments.action !== 'string'
    || !TOOL_ACTIONS.has(parsedArguments.action)
  ) {
    return {
      classification: CLASSIFICATIONS.WRONG_SHAPE,
      selectedToolCall,
      parsedArguments,
      parseError: '',
    };
  }

  return {
    classification: CLASSIFICATIONS.OK,
    selectedToolCall,
    parsedArguments,
    parseError: '',
  };
}

function baseTrialRecord(config, endpoint, trialNumber, approxPromptTokens, longContextTargetTokens) {
  return {
    providerTag: endpoint.tag,
    endpointProviderName: endpoint.providerName,
    endpointStatus: endpoint.statusText,
    quantization: endpoint.quantization,
    contextLength: endpoint.contextLength,
    trial: trialNumber,
    model: config.model,
    reasoningEnabled: config.reasoningEnabled,
    longContext: config.longContext,
    approxPromptTokens,
    longContextTargetTokens,
    classification: '',
    servedProviderName: '',
    servedProviderNames: [],
    toolCallId: '',
    toolCallIdPrefixStyle: '',
    toolName: '',
    toolCalls: [],
    reasoningBytes: 0,
    argsPreview: '',
    argumentsRaw: '',
    latencyMs: null,
    httpStatus: null,
    error: '',
    attempts: 1,
  };
}

function classificationRecord(config, endpoint, trialNumber, timing, requestMeta, streamResult) {
  const classified = classifyToolCall(streamResult.toolCalls);
  const selected = classified.selectedToolCall;
  const argsRaw = selected?.arguments ?? '';
  return {
    ...baseTrialRecord(config, endpoint, trialNumber, requestMeta.approxPromptTokens, requestMeta.longContextTargetTokens),
    classification: classified.classification,
    servedProviderName: streamResult.providerNames[0] ?? '',
    servedProviderNames: streamResult.providerNames,
    toolCallId: selected?.id ?? '',
    toolCallIdPrefixStyle: classifyToolCallId(selected?.id ?? ''),
    toolName: selected?.functionName ?? '',
    toolCalls: streamResult.toolCalls,
    reasoningBytes: streamResult.reasoningBytes,
    argsPreview: truncateText(argsRaw, ARG_PREVIEW_CHARS),
    argumentsRaw: argsRaw,
    latencyMs: timing.latencyMs,
    httpStatus: 200,
    error: classified.parseError,
  };
}

async function postTrialAttempt(config, apiKey, endpoint, trialNumber) {
  const requestMeta = buildChatRequestBody(config, endpoint);
  const requestBody = JSON.stringify(requestMeta.body);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutSeconds * 1_000);
  const startedAtMs = Date.now();

  let response;
  try {
    response = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        accept: 'text/event-stream',
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: requestBody,
    });
  } catch (error) {
    clearTimeout(timeout);
    const latencyMs = Date.now() - startedAtMs;
    const record = {
      ...baseTrialRecord(config, endpoint, trialNumber, requestMeta.approxPromptTokens, requestMeta.longContextTargetTokens),
      classification: isAbortError(error) ? CLASSIFICATIONS.TIMEOUT : CLASSIFICATIONS.HTTP_ERROR,
      latencyMs,
      error: isAbortError(error)
        ? `request timed out after ${config.timeoutSeconds}s`
        : error instanceof Error ? error.message : String(error),
    };
    return { record, retryable429: false, skipped404: false };
  }

  try {
    if (response.status === 429) {
      const latencyMs = Date.now() - startedAtMs;
      const body = truncateText(await readResponseText(response), 300);
      const record = {
        ...baseTrialRecord(config, endpoint, trialNumber, requestMeta.approxPromptTokens, requestMeta.longContextTargetTokens),
        classification: CLASSIFICATIONS.HTTP_ERROR,
        latencyMs,
        httpStatus: response.status,
        error: body ? `HTTP 429: ${body}` : 'HTTP 429',
      };
      return { record, retryable429: true, skipped404: false };
    }

    if (response.status === 404) {
      const latencyMs = Date.now() - startedAtMs;
      const body = truncateText(await readResponseText(response), 300);
      const record = {
        ...baseTrialRecord(config, endpoint, trialNumber, requestMeta.approxPromptTokens, requestMeta.longContextTargetTokens),
        classification: CLASSIFICATIONS.SKIPPED_404,
        latencyMs,
        httpStatus: response.status,
        error: body ? `HTTP 404: ${body}` : 'HTTP 404 provider/model not served',
      };
      return { record, retryable429: false, skipped404: true };
    }

    if (!response.ok) {
      const latencyMs = Date.now() - startedAtMs;
      const body = truncateText(await readResponseText(response), 300);
      const record = {
        ...baseTrialRecord(config, endpoint, trialNumber, requestMeta.approxPromptTokens, requestMeta.longContextTargetTokens),
        classification: CLASSIFICATIONS.HTTP_ERROR,
        latencyMs,
        httpStatus: response.status,
        error: body ? `HTTP ${response.status}: ${body}` : `HTTP ${response.status}`,
      };
      return { record, retryable429: false, skipped404: false };
    }

    const streamResult = await readOpenRouterSse(response);
    const latencyMs = Date.now() - startedAtMs;
    return {
      record: classificationRecord(config, endpoint, trialNumber, { latencyMs }, requestMeta, streamResult),
      retryable429: false,
      skipped404: false,
    };
  } catch (error) {
    const latencyMs = Date.now() - startedAtMs;
    const record = {
      ...baseTrialRecord(config, endpoint, trialNumber, requestMeta.approxPromptTokens, requestMeta.longContextTargetTokens),
      classification: isAbortError(error) ? CLASSIFICATIONS.TIMEOUT : CLASSIFICATIONS.HTTP_ERROR,
      latencyMs,
      httpStatus: response.status,
      error: isAbortError(error)
        ? `request timed out after ${config.timeoutSeconds}s`
        : error instanceof Error ? error.message : String(error),
    };
    return { record, retryable429: false, skipped404: false };
  } finally {
    clearTimeout(timeout);
  }
}

async function runTrialWithRetries(config, apiKey, endpoint, trialNumber) {
  let lastResult = null;
  for (let attempt = 1; attempt <= RETRYABLE_429_RETRIES + 1; attempt += 1) {
    const result = await postTrialAttempt(config, apiKey, endpoint, trialNumber);
    result.record.attempts = attempt;
    lastResult = result;
    if (!result.retryable429) return result;
    if (attempt <= RETRYABLE_429_RETRIES) {
      const backoffMs = 750 * 2 ** (attempt - 1);
      await sleep(backoffMs);
    }
  }
  return lastResult;
}

async function runProviderTrials(config, apiKey, endpoint) {
  const records = [];
  for (let trial = 1; trial <= config.trials; trial += 1) {
    const result = await runTrialWithRetries(config, apiKey, endpoint, trial);
    records.push(result.record);
    if (result.skipped404) break;
  }
  return {
    endpoint,
    records,
  };
}

async function runWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

function countClassification(records, classification) {
  return records.filter(record => record.classification === classification).length;
}

function median(values) {
  const sorted = values
    .filter(value => Number.isFinite(value))
    .sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

function summarizeSet(values, fallback = '') {
  const unique = Array.from(new Set(values.map(trimString).filter(Boolean)));
  if (unique.length === 0) return fallback;
  if (unique.length <= 2) return unique.join(',');
  return `${unique.slice(0, 2).join(',')} +${unique.length - 2}`;
}

function summarizeProviderResult(providerResult) {
  const records = providerResult.records;
  const errors = records.filter(record => [
    CLASSIFICATIONS.HTTP_ERROR,
    CLASSIFICATIONS.TIMEOUT,
    CLASSIFICATIONS.SKIPPED_404,
  ].includes(record.classification)).length;
  const trialRecords = records.filter(record => record.classification !== CLASSIFICATIONS.SKIPPED_404);
  const idPrefixStyles = records.map(record => record.toolCallIdPrefixStyle).filter(Boolean);
  const servedProviderNames = records.flatMap(record => record.servedProviderNames ?? []);
  const latencyMs = median(records.map(record => record.latencyMs));
  const approxPromptTokens = median(records.map(record => record.approxPromptTokens));

  return {
    providerTag: providerResult.endpoint.tag,
    endpointProviderName: providerResult.endpoint.providerName,
    endpointStatus: providerResult.endpoint.statusText,
    quantization: providerResult.endpoint.quantization,
    contextLength: providerResult.endpoint.contextLength,
    servedProviderName: summarizeSet(servedProviderNames, providerResult.endpoint.providerName),
    trials: trialRecords.length,
    ok: countClassification(records, CLASSIFICATIONS.OK),
    emptyArgs: countClassification(records, CLASSIFICATIONS.EMPTY_ARGS),
    badJson: countClassification(records, CLASSIFICATIONS.BAD_JSON),
    wrongShape: countClassification(records, CLASSIFICATIONS.WRONG_SHAPE),
    noToolCall: countClassification(records, CLASSIFICATIONS.NO_TOOL_CALL),
    errors,
    skipped404: countClassification(records, CLASSIFICATIONS.SKIPPED_404),
    timeout: countClassification(records, CLASSIFICATIONS.TIMEOUT),
    httpError: countClassification(records, CLASSIFICATIONS.HTTP_ERROR),
    idPrefixStyles: summarizeSet(idPrefixStyles, ''),
    medianLatencyMs: latencyMs,
    approxPromptTokens,
    classifications: records.map(record => record.classification),
  };
}

function providerBadness(summary) {
  return summary.emptyArgs * 1_000
    + summary.badJson * 900
    + summary.wrongShape * 600
    + summary.noToolCall * 400
    + summary.errors * 300
    - summary.ok;
}

function sortWorstFirst(summaries) {
  return [...summaries].sort((left, right) => {
    const badness = providerBadness(right) - providerBadness(left);
    if (badness !== 0) return badness;
    return left.providerTag.localeCompare(right.providerTag);
  });
}

function sortBestFirst(summaries) {
  return [...summaries].sort((left, right) => {
    if (right.ok !== left.ok) return right.ok - left.ok;
    const leftLatency = left.medianLatencyMs ?? Number.POSITIVE_INFINITY;
    const rightLatency = right.medianLatencyMs ?? Number.POSITIVE_INFINITY;
    if (leftLatency !== rightLatency) return leftLatency - rightLatency;
    return left.providerTag.localeCompare(right.providerTag);
  });
}

function reliableSummaries(summaries) {
  return summaries.filter(summary => (
    summary.ok > 0
    && summary.emptyArgs === 0
    && summary.badJson === 0
    && summary.wrongShape === 0
    && summary.noToolCall === 0
    && summary.errors === 0
  ));
}

function clipCell(value, limit = 42) {
  const text = value === null || value === undefined ? '' : String(value);
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 3)}...`;
}

function formatMs(value) {
  if (!Number.isFinite(value)) return '';
  return `${Math.round(value)}ms`;
}

function printTable(rows) {
  if (rows.length === 0) {
    console.log('No runnable providers after filtering and endpoint status checks.');
    return;
  }

  const headers = [
    'provider tag',
    'served-name',
    'trials',
    'ok',
    'empty_args',
    'bad_json',
    'wrong_shape',
    'no_tool_call',
    'errors',
    'id-prefix style(s)',
    'median latency',
  ];
  const cells = rows.map(row => [
    clipCell(row.providerTag),
    clipCell(row.servedProviderName),
    String(row.trials),
    String(row.ok),
    String(row.emptyArgs),
    String(row.badJson),
    String(row.wrongShape),
    String(row.noToolCall),
    String(row.errors),
    clipCell(row.idPrefixStyles),
    formatMs(row.medianLatencyMs),
  ]);
  const widths = headers.map((header, index) => Math.max(
    header.length,
    ...cells.map(row => row[index].length),
  ));

  const formatRow = row => row
    .map((cell, index) => cell.padEnd(widths[index]))
    .join('  ');

  console.log(formatRow(headers));
  console.log(formatRow(widths.map(width => '-'.repeat(width))));
  for (const row of cells) {
    console.log(formatRow(row));
  }
}

function machineSummary(config, normalized, providerResults) {
  const summaries = providerResults.map(summarizeProviderResult);
  const doNotRoute = sortWorstFirst(summaries)
    .filter(summary => summary.emptyArgs > 0 || summary.badJson > 0);
  const reliable = sortBestFirst(reliableSummaries(summaries));
  return {
    model: config.model,
    trialsPerProvider: config.trials,
    reasoningEnabled: config.reasoningEnabled,
    longContext: config.longContext,
    concurrency: config.concurrency,
    timeoutSeconds: config.timeoutSeconds,
    endpointCount: normalized.endpoints.length,
    runnableEndpointCount: normalized.runnable.length,
    skippedEndpointCount: normalized.skipped.length,
    providerSummaries: sortWorstFirst(summaries),
    doNotRouteProviderTags: doNotRoute.map(summary => summary.providerTag),
    reliableProviderTags: reliable.map(summary => summary.providerTag),
    recommendedProviderOrder: reliable.slice(0, 3).map(summary => summary.providerTag),
  };
}

function printHumanOutput(config, normalized, providerResults, summary) {
  console.log(`OpenRouter tool-call eval for ${config.model}`);
  console.log(`Providers: ${summary.runnableEndpointCount} runnable / ${summary.endpointCount} discovered; trials/provider=${config.trials}; reasoning=${config.reasoningEnabled ? 'on' : 'off'}; long_context=${config.longContext ? 'on' : 'off'}; concurrency=${config.concurrency}`);
  if (config.providerFilters.length > 0) {
    console.log(`Provider tag filters: ${config.providerFilters.join(', ')}`);
  }

  const negativeSkipped = normalized.skipped.filter(endpoint => endpoint.skipReason === 'NEGATIVE_STATUS');
  if (negativeSkipped.length > 0) {
    console.log('');
    console.log('Skipped endpoints with negative status:');
    for (const endpoint of negativeSkipped) {
      console.log(`  ${endpoint.tag} (${endpoint.providerName || 'unknown provider'}), status=${endpoint.statusText || '<empty>'}`);
    }
  }

  const filteredSkipped = normalized.skipped.filter(endpoint => endpoint.skipReason === 'FILTERED_BY_PROVIDERS');
  if (filteredSkipped.length > 0 && config.providerFilters.length > 0) {
    console.log(`Filtered out ${filteredSkipped.length} endpoints by --providers.`);
  }

  if (config.longContext) {
    const promptTokenValues = providerResults
      .flatMap(result => result.records.map(record => record.approxPromptTokens))
      .filter(value => Number.isFinite(value));
    const minTokens = promptTokenValues.length > 0 ? Math.min(...promptTokenValues) : null;
    const maxTokens = promptTokenValues.length > 0 ? Math.max(...promptTokenValues) : null;
    if (minTokens !== null && maxTokens !== null) {
      console.log(`Approx prompt size with filler: ${minTokens === maxTokens ? minTokens : `${minTokens}-${maxTokens}`} tokens`);
    }
  }

  console.log('');
  printTable(summary.providerSummaries);

  console.log('');
  console.log('Verdict');
  const doNotRoute = summary.doNotRouteProviderTags;
  if (doNotRoute.length === 0) {
    console.log('Do not route: none from EMPTY_ARGS/BAD_JSON in this run.');
  } else {
    console.log(`Do not route: ${doNotRoute.join(', ')} (observed EMPTY_ARGS or BAD_JSON)`);
  }

  const bestTags = summary.recommendedProviderOrder;
  if (bestTags.length > 0) {
    console.log(`LiteLLM/OpenRouter pinning hint: provider:{order:${JSON.stringify(bestTags)},allow_fallbacks:false}`);
  } else {
    console.log('LiteLLM/OpenRouter pinning hint: no fully reliable provider order found in this run.');
  }
}

async function writeJsonOutput(config, payload) {
  if (!config.jsonPath) return;
  const outputPath = resolve(config.jsonPath);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(`Full JSON written to ${outputPath}`);
}

async function main() {
  let config;
  try {
    config = parseArgs(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`FAIL setup: ${message}`);
    usage();
    process.exitCode = 2;
    return;
  }

  if (config.help) {
    usage();
    return;
  }

  const apiKey = trimString(process.env.OPENROUTER_API_KEY);
  if (!apiKey) {
    console.error('FAIL setup: OPENROUTER_API_KEY is required in the environment. The key is never printed.');
    process.exitCode = 2;
    return;
  }

  const startedAt = new Date().toISOString();
  let normalized;
  if (config.noPin) {
    // --no-pin: let OpenRouter route freely (e.g. to eval a :exacto variant slug).
    // One synthetic endpoint; each trial records whichever provider actually served it.
    const unpinned = {
      index: 0,
      providerName: '(router-chosen)',
      tag: 'unpinned',
      tagWasFallback: true,
      status: 0,
      statusText: statusToString(0),
      quantization: '',
      contextLength: undefined,
      raw: null,
    };
    normalized = { endpoints: [unpinned], runnable: [unpinned], skipped: [] };
  } else {
    let endpointPayload;
    try {
      endpointPayload = await fetchModelEndpoints(config, apiKey);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`FAIL endpoints: ${message}`);
      process.exitCode = 1;
      return;
    }
    normalized = normalizeEndpoints(endpointPayload, config.providerFilters);
  }
  const providerResults = await runWithConcurrency(
    normalized.runnable,
    config.concurrency,
    endpoint => runProviderTrials(config, apiKey, endpoint),
  );
  const completedAt = new Date().toISOString();
  const summary = machineSummary(config, normalized, providerResults);
  const output = {
    run: {
      startedAt,
      completedAt,
      model: config.model,
      trialsPerProvider: config.trials,
      reasoningEnabled: config.reasoningEnabled,
      longContext: config.longContext,
      concurrency: config.concurrency,
      timeoutSeconds: config.timeoutSeconds,
      providerFilters: config.providerFilters,
    },
    endpoints: normalized.endpoints,
    skippedEndpoints: normalized.skipped,
    providerResults,
    summary,
  };

  printHumanOutput(config, normalized, providerResults, summary);
  await writeJsonOutput(config, output);
}

await main();
