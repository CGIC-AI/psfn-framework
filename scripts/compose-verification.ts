import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const API_KEY_PRINCIPAL_DIGEST_LENGTH = 24;
const CHAT_TIMEOUT_MS = 180_000;
const TURN_RECORD_TIMEOUT_MS = 30_000;
const TURN_RECORD_POLL_MS = 500;

export interface PersistedComposeTurn {
  status?: unknown;
  userMessage?: { content?: unknown };
  assistantMessage?: { content?: unknown };
}

export interface ComposeVerificationResult {
  assistantContent: string;
  message: string;
  sessionId: string;
  turnRecordPath: string;
}

export interface DeploymentVerificationOptions {
  apiBase: string;
  apiKey: string;
  companionDataDir: string;
  proofLabel: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function composeApiPrincipalId(apiKey: string): string {
  const digest = createHash('sha256')
    .update(apiKey)
    .digest('hex')
    .slice(0, API_KEY_PRINCIPAL_DIGEST_LENGTH);
  return `api-key-${digest}`;
}

export function composeTurnRecordPath(
  dataRoot: string,
  apiKey: string,
  sessionId: string,
): string {
  return deploymentTurnRecordPath(join(dataRoot, 'companion-data', 'main'), apiKey, sessionId);
}

export function deploymentTurnRecordPath(
  companionDataDir: string,
  apiKey: string,
  sessionId: string,
): string {
  const channelId = `api:${composeApiPrincipalId(apiKey)}:${sessionId}`;
  return join(
    companionDataDir,
    'state',
    'sessions',
    '_turn_records',
    `${encodeURIComponent(channelId)}.jsonl`,
  );
}

export function findMatchingPersistedTurn(
  path: string,
  message: string,
): PersistedComposeTurn | undefined {
  if (!existsSync(path)) return undefined;
  const lines = readFileSync(path, 'utf8').split(/\r?\n/u);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (!line) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (!isRecord(value) || !isRecord(value.userMessage)) continue;
      if (value.userMessage.content !== message) continue;
      return value as PersistedComposeTurn;
    } catch {
      // An active JSONL file can have an incomplete trailing write. Keep
      // looking for the last complete record instead of accepting bad data.
    }
  }
  return undefined;
}

export function assertCompletedPersistedTurn(
  turn: PersistedComposeTurn | undefined,
  message: string,
  assistantContent: string,
): void {
  if (turn?.status !== 'completed') {
    throw new Error('the exact persisted TurnRecord is missing or incomplete');
  }
  if (turn.userMessage?.content !== message) {
    throw new Error('the persisted TurnRecord does not contain the exact user message');
  }
  if (turn.assistantMessage?.content !== assistantContent) {
    throw new Error('the HTTP assistant reply does not match the persisted TurnRecord');
  }
}

async function waitForPersistedTurn(
  path: string,
  message: string,
  assistantContent: string,
): Promise<void> {
  const deadline = Date.now() + TURN_RECORD_TIMEOUT_MS;
  let lastError: Error | undefined;
  do {
    try {
      assertCompletedPersistedTurn(findMatchingPersistedTurn(path, message), message, assistantContent);
      return;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
    await new Promise(resolve => setTimeout(resolve, TURN_RECORD_POLL_MS));
  } while (Date.now() <= deadline);
  throw lastError ?? new Error('timed out waiting for the persisted TurnRecord');
}

export async function runComposeChatVerification(options: {
  apiBase: string;
  apiKey: string;
  dataRoot: string;
}): Promise<ComposeVerificationResult> {
  return runDeploymentChatVerification({
    apiBase: options.apiBase,
    apiKey: options.apiKey,
    companionDataDir: join(options.dataRoot, 'companion-data', 'main'),
    proofLabel: 'Compose',
  });
}

export async function runDeploymentChatVerification(
  options: DeploymentVerificationOptions,
): Promise<ComposeVerificationResult> {
  const proofId = randomUUID();
  const slug = options.proofLabel.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '');
  const sessionId = `${slug}-verify-${proofId}`;
  const message = `PSFN ${options.proofLabel} persistence proof ${proofId}. Reply with a brief acknowledgement.`;
  const response = await fetch(`${options.apiBase}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${options.apiKey}`,
      'Content-Type': 'application/json',
      'X-Session-Id': sessionId,
    },
    body: JSON.stringify({
      model: 'companion',
      messages: [{ role: 'user', content: message }],
      response_style: 'concise',
      stream: false,
    }),
    signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
  });
  const rawBody = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    body = undefined;
  }
  const firstChoice = isRecord(body) && Array.isArray(body.choices) ? body.choices[0] : undefined;
  const messageBody = isRecord(firstChoice) && isRecord(firstChoice.message)
    ? firstChoice.message
    : undefined;
  const assistantContent = typeof messageBody?.content === 'string'
    ? messageBody.content.trim()
    : '';
  if (!response.ok || !assistantContent) {
    const detail = isRecord(body) && isRecord(body.error) && typeof body.error.message === 'string'
      ? body.error.message
      : rawBody.slice(0, 300);
    throw new Error(`chat completion failed (HTTP ${response.status}): ${detail}`);
  }

  const turnRecordPath = deploymentTurnRecordPath(options.companionDataDir, options.apiKey, sessionId);
  await waitForPersistedTurn(turnRecordPath, message, assistantContent);
  return { assistantContent, message, sessionId, turnRecordPath };
}

export function reverifyPersistedComposeTurn(result: ComposeVerificationResult): void {
  assertCompletedPersistedTurn(
    findMatchingPersistedTurn(result.turnRecordPath, result.message),
    result.message,
    result.assistantContent,
  );
}
