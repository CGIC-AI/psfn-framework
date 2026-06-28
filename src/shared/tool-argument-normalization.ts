import { isRecord } from './utils/types.js';
function normalizeOptionalString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeStructuredString(
  value: unknown,
  nestedKeys: readonly string[],
): string {
  const direct = normalizeOptionalString(value);
  if (direct) {
    return direct;
  }
  if (!isRecord(value)) {
    return '';
  }
  for (const key of nestedKeys) {
    const nested = normalizeOptionalString(value[key]);
    if (nested) {
      return nested;
    }
  }
  return '';
}

function normalizeArgumentKey(key: string): string {
  return key
    .trim()
    .replace(/^[^a-zA-Z0-9_]+/, '')
    .replace(/[^a-zA-Z0-9_]+$/, '')
    .toLowerCase();
}

function findAliasEntry(
  args: Record<string, unknown>,
  aliases: readonly string[],
): { key: string; value: string } | null {
  const aliasSet = new Set(aliases.map(alias => alias.toLowerCase()));
  for (const [key, rawValue] of Object.entries(args)) {
    const value = normalizeOptionalString(rawValue);
    if (!value) continue;
    if (!aliasSet.has(normalizeArgumentKey(key))) continue;
    return { key, value };
  }
  return null;
}

function stripQuotedPrefix(value: string): string {
  return value.replace(/^>\s*/, '').trim();
}

function normalizeAliasedStringArgument(
  args: Record<string, unknown>,
  canonicalKey: string,
  aliases: readonly string[],
): Record<string, unknown> {
  const normalizedCanonicalKey = normalizeArgumentKey(canonicalKey);
  const aliasSet = new Set(aliases.map(alias => normalizeArgumentKey(alias)));
  const canonicalValue = normalizeOptionalString(args[canonicalKey]);
  const hasAliasKeys = Object.keys(args).some(
    key => key !== canonicalKey && (normalizeArgumentKey(key) === normalizedCanonicalKey || aliasSet.has(normalizeArgumentKey(key))),
  );

  if (canonicalValue.length > 0 && !hasAliasKeys) {
    return args;
  }

  const resolvedValue = canonicalValue.length > 0
    ? canonicalValue
    : findAliasEntry(args, aliases)?.value ?? '';
  if (!resolvedValue) {
    return args;
  }

  const normalized = { ...args, [canonicalKey]: resolvedValue };
  for (const key of Object.keys(args)) {
    const normalizedKey = normalizeArgumentKey(key);
    if (key !== canonicalKey && (normalizedKey === normalizedCanonicalKey || aliasSet.has(normalizedKey))) {
      delete normalized[key];
    }
  }
  return normalized;
}

function looksLikeMalformedJsonTail(value: string): boolean {
  if (!value) return false;
  if (/^[:},\]]/.test(value)) return true;
  return !value.startsWith('{') && /"\w[\w-]*"\s*:/.test(value);
}

function looksLikePlaceholderText(value: string): boolean {
  return /^[.?!,:;]+$/.test(value);
}

function normalizeFsReadArguments(args: Record<string, unknown>): Record<string, unknown> {
  const pathEntry = findAliasEntry(args, ['path', 'file_path', 'filepath']);
  const rawPath = pathEntry?.value ?? '';
  if (!rawPath) {
    return args;
  }

  const normalizedPath = rawPath.startsWith('>')
    ? stripQuotedPrefix(rawPath)
    : rawPath;

  if (
    pathEntry?.key === 'path'
    && normalizedPath === normalizeOptionalString(args.path)
  ) {
    return args;
  }

  const normalized = { ...args, path: normalizedPath };
  for (const key of Object.keys(args)) {
    const canonicalKey = normalizeArgumentKey(key);
    if ((canonicalKey === 'path' || canonicalKey === 'file_path' || canonicalKey === 'filepath') && key !== 'path') {
      delete normalized[key];
    }
  }
  return normalized;
}

function normalizeMemoryWriteArguments(args: Record<string, unknown>): Record<string, unknown> {
  const textEntry = findAliasEntry(args, ['text']);
  const typeEntry = findAliasEntry(args, ['type', 'ty']);
  const sensitivityEntry = findAliasEntry(args, ['sensitivity']);
  const text = textEntry?.value ?? '';
  const content = normalizeOptionalString(args.content);
  const stepText = normalizeOptionalString(args.step_text);
  const aliasCandidates = [content, stepText].filter(value => value.length > 0);
  const aliasText = aliasCandidates[0] ?? '';
  const shouldUseAlias = text.length === 0
    || looksLikeMalformedJsonTail(text)
    || (aliasText.length > 0 && looksLikePlaceholderText(text));
  let normalizedText = shouldUseAlias && aliasText.length > 0 ? aliasText : text;
  const recoveredMalformedKey = [textEntry, typeEntry, sensitivityEntry].some(
    entry => entry !== null && normalizeArgumentKey(entry.key) !== entry.key.toLowerCase(),
  );
  if (recoveredMalformedKey && normalizedText.startsWith('>')) {
    normalizedText = stripQuotedPrefix(normalizedText);
  }
  const type = typeEntry?.value ?? '';
  const sensitivity = sensitivityEntry?.value ?? '';

  if (
    normalizedText === text
    && content.length === 0
    && stepText.length === 0
    && type === normalizeOptionalString(args.type)
    && sensitivity === normalizeOptionalString(args.sensitivity)
  ) {
    return args;
  }

  const normalized = { ...args };
  if (normalizedText.length > 0) {
    normalized.text = normalizedText;
  }
  if (type.length > 0) {
    normalized.type = type;
  }
  if (sensitivity.length > 0) {
    normalized.sensitivity = sensitivity;
  }
  for (const key of Object.keys(args)) {
    const canonicalKey = normalizeArgumentKey(key);
    if ((canonicalKey === 'text' || canonicalKey === 'type' || canonicalKey === 'ty' || canonicalKey === 'sensitivity') && key !== canonicalKey) {
      delete normalized[key];
    }
  }
  delete normalized.content;
  delete normalized.step_text;
  return normalized;
}

function normalizeLifecycleArguments(args: Record<string, unknown>): Record<string, unknown> {
  const reason = normalizeStructuredString(
    args.reason,
    ['note', 'marker', 'text', 'value', 'primary_reason', 'primaryReason'],
  );
  if (!reason || reason === normalizeOptionalString(args.reason)) {
    return args;
  }
  return {
    ...args,
    reason,
  };
}

function normalizeUnifiedMemoryArguments(args: Record<string, unknown>): Record<string, unknown> {
  const action = normalizeOptionalString(args.action).toLowerCase();
  if (action === 'write') {
    return normalizeMemoryWriteArguments(args);
  }
  if (action === 'delete' || action === 'patch' || action === 'redact') {
    return normalizeAliasedStringArgument(args, 'memory_id', ['id', 'memoryId']);
  }
  if (action === 'restore') {
    return normalizeAliasedStringArgument(args, 'delete_id', ['id', 'deleteId']);
  }
  return args;
}

export function normalizeToolArguments(
  toolName: string,
  args: unknown,
): Record<string, unknown> | undefined {
  if (!isRecord(args)) return undefined;

  if (toolName === 'fs_read') {
    return normalizeFsReadArguments(args);
  }

  if (toolName === 'memory_write') {
    return normalizeMemoryWriteArguments(args);
  }

  if (toolName === 'memory') {
    return normalizeUnifiedMemoryArguments(args);
  }

  if (toolName === 'self_restart' || toolName === 'self_rebuild') {
    return normalizeLifecycleArguments(args);
  }

  if (toolName === 'system') {
    const action = normalizeOptionalString(args.action).toLowerCase();
    if (!action || action === 'restart' || action === 'self_restart' || action === 'rebuild' || action === 'self_rebuild') {
      return normalizeLifecycleArguments(args);
    }
    return args;
  }

  return args;
}
