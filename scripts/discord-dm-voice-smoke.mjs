#!/usr/bin/env node

import process from 'node:process';
import { createRequire } from 'node:module';

const DISCORD_API_BASE = 'https://discord.com/api/v10';
const DEFAULT_TIMEOUT_MS = 10_000;
const OPUS_BACKEND_PRIORITY = ['@discordjs/opus', 'node-opus', 'opusscript'];
const VALID_TTS_PROVIDERS = new Set(['elevenlabs', 'echo']);

function printUsage() {
  console.log(`Discord DM + Voice Readiness Smoke

Usage:
  node scripts/discord-dm-voice-smoke.mjs [options]

Safe defaults:
  - Runs in dry-run mode by default (no Discord network calls).
  - Uses environment variables for readiness checks.
  - Exits non-zero when readiness fails unless --report-only is set.

Options:
  --dry-run                 Run local readiness checks only (default)
  --live                    Add read-only Discord API checks (GET only)
  --report-only             Always exit 0 after printing readiness report
  --strict                  Exit non-zero when readiness checks fail (default)
  --timeout-ms <ms>         HTTP timeout for --live checks (default: ${DEFAULT_TIMEOUT_MS})

  --token <token>           Override DISCORD_TOKEN
  --bot-id <id>             Override DISCORD_BOT_ID
  --guild-id <id>           Override VOICE_TARGET_GUILD_ID
  --target-user-id <id>     Override VOICE_TARGET_USER_ID
  --dm-channel-id <id>      Optional DM channel ID for live API validation
  --voice-channel-id <id>   Optional voice channel ID for live API validation
  --tts-provider <id>       Override TTS_PROVIDER / VOICE_TTS_PROVIDER (elevenlabs|echo)
  --voice-enabled <bool>    Override VOICE_ENABLED (true|false)
  --help                    Show this help

Environment variables consumed:
  DISCORD_TOKEN
  DISCORD_BOT_ID
  VOICE_ENABLED
  VOICE_TARGET_GUILD_ID
  VOICE_TARGET_USER_ID
  DEEPGRAM_API_KEY
  TTS_PROVIDER / VOICE_TTS_PROVIDER
  ELEVENLABS_API_KEY
  ELEVENLABS_VOICE_ID (optional; runtime default exists)
  ECHO_TTS_URL
  ECHO_TTS_VOICE
  DISCORD_SMOKE_DM_CHANNEL_ID
  DISCORD_SMOKE_VOICE_CHANNEL_ID
`);
}

function info(message) {
  console.log(`[smoke:discord] ${message}`);
}

function pass(message) {
  console.log(`[smoke:discord] PASS  ${message}`);
}

function warn(message) {
  console.warn(`[smoke:discord] WARN  ${message}`);
}

function fail(message) {
  console.error(`[smoke:discord] FAIL  ${message}`);
}

function trimString(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}

function ensureArgValue(value, flagName) {
  const trimmed = trimString(value);
  if (!trimmed) {
    throw new Error(`Expected value for ${flagName}`);
  }
  return trimmed;
}

function parsePositiveInt(value, flagName, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${flagName}: ${value}`);
  }
  return parsed;
}

function parseBoolean(value) {
  const normalized = trimString(value).toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return false;
}

function toErrorMessage(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

function normalizeTtsProvider(raw) {
  const provider = trimString(raw).toLowerCase() || 'elevenlabs';
  if (VALID_TTS_PROVIDERS.has(provider)) return provider;
  return provider;
}

function parseArgs(argv) {
  const options = {
    dryRun: true,
    strict: true,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    token: trimString(process.env.DISCORD_TOKEN),
    botId: trimString(process.env.DISCORD_BOT_ID),
    guildId: trimString(process.env.VOICE_TARGET_GUILD_ID),
    targetUserId: trimString(process.env.VOICE_TARGET_USER_ID),
    deepgramApiKey: trimString(process.env.DEEPGRAM_API_KEY),
    ttsProvider: normalizeTtsProvider(process.env.TTS_PROVIDER || process.env.VOICE_TTS_PROVIDER),
    elevenLabsApiKey: trimString(process.env.ELEVENLABS_API_KEY),
    elevenLabsVoiceId: trimString(process.env.ELEVENLABS_VOICE_ID),
    echoTtsUrl: trimString(process.env.ECHO_TTS_URL),
    echoTtsVoice: trimString(process.env.ECHO_TTS_VOICE),
    voiceEnabled: parseBoolean(process.env.VOICE_ENABLED),
    dmChannelId: trimString(process.env.DISCORD_SMOKE_DM_CHANNEL_ID),
    voiceChannelId: trimString(process.env.DISCORD_SMOKE_VOICE_CHANNEL_ID),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--help':
      case '-h':
        printUsage();
        process.exit(0);
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--live':
        options.dryRun = false;
        break;
      case '--report-only':
        options.strict = false;
        break;
      case '--strict':
        options.strict = true;
        break;
      case '--timeout-ms':
        options.timeoutMs = parsePositiveInt(argv[++index], '--timeout-ms', DEFAULT_TIMEOUT_MS);
        break;
      case '--token':
        options.token = ensureArgValue(argv[++index], '--token');
        break;
      case '--bot-id':
        options.botId = ensureArgValue(argv[++index], '--bot-id');
        break;
      case '--guild-id':
        options.guildId = ensureArgValue(argv[++index], '--guild-id');
        break;
      case '--target-user-id':
        options.targetUserId = ensureArgValue(argv[++index], '--target-user-id');
        break;
      case '--dm-channel-id':
        options.dmChannelId = ensureArgValue(argv[++index], '--dm-channel-id');
        break;
      case '--voice-channel-id':
        options.voiceChannelId = ensureArgValue(argv[++index], '--voice-channel-id');
        break;
      case '--tts-provider':
        options.ttsProvider = normalizeTtsProvider(ensureArgValue(argv[++index], '--tts-provider'));
        break;
      case '--voice-enabled': {
        const value = ensureArgValue(argv[++index], '--voice-enabled').toLowerCase();
        if (!['1', '0', 'true', 'false', 'yes', 'no', 'on', 'off'].includes(value)) {
          throw new Error(`Invalid --voice-enabled value: ${value}`);
        }
        options.voiceEnabled = parseBoolean(value);
        break;
      }
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function detectInstalledOpusBackends() {
  const require = createRequire(import.meta.url);
  const installed = [];

  for (const backend of OPUS_BACKEND_PRIORITY) {
    try {
      require.resolve(backend);
      installed.push(backend);
    } catch {
      // Optional backend not installed.
    }
  }

  return installed;
}

async function checkPrismOpusDecoder() {
  try {
    const prismModule = await import('prism-media');
    const prism = prismModule.default ?? prismModule;
    const Decoder = prism?.opus?.Decoder;

    if (typeof Decoder !== 'function') {
      throw new Error('prism-media opus decoder constructor is not available');
    }

    const decoder = new Decoder({
      rate: 48_000,
      channels: 2,
      frameSize: 960,
    });
    decoder.destroy?.();

    const backend = typeof prism?.opus?.module === 'string' ? prism.opus.module : null;
    return {
      available: true,
      backend,
      error: null,
    };
  } catch (error) {
    return {
      available: false,
      backend: null,
      error: toErrorMessage(error),
    };
  }
}

function evaluateTtsProviderReadiness(options) {
  const preferredProvider = options.ttsProvider;
  const hasElevenLabs = Boolean(options.elevenLabsApiKey);
  const hasEcho = Boolean(options.echoTtsUrl && options.echoTtsVoice);

  const issues = [];
  const warnings = [];

  if (!VALID_TTS_PROVIDERS.has(preferredProvider)) {
    issues.push(`Unsupported TTS provider: ${preferredProvider}`);
  }

  const hasAnyConnectorConfig = hasElevenLabs || hasEcho;
  if (!hasAnyConnectorConfig) {
    issues.push('Missing TTS config: set ELEVENLABS_API_KEY or ECHO_TTS_URL + ECHO_TTS_VOICE');
  }

  if (preferredProvider === 'elevenlabs' && !hasElevenLabs && hasEcho) {
    warnings.push('Preferred provider elevenlabs missing config; runtime would rely on echo fallback');
  }
  if (preferredProvider === 'echo' && !hasEcho && hasElevenLabs) {
    warnings.push('Preferred provider echo missing config; runtime would rely on elevenlabs fallback');
  }

  if (hasElevenLabs && !options.elevenLabsVoiceId) {
    warnings.push('ELEVENLABS_VOICE_ID not set; runtime default voice ID will be used');
  }

  return {
    ready: issues.length === 0,
    issues,
    warnings,
    preferredProvider,
    hasElevenLabs,
    hasEcho,
  };
}

async function evaluateReadiness(options) {
  const errors = [];
  const warnings = [];

  const dmMissing = [];
  if (!options.token) dmMissing.push('DISCORD_TOKEN');
  if (!options.botId) dmMissing.push('DISCORD_BOT_ID');

  if (dmMissing.length === 0) {
    pass('DM routing prerequisites present (DISCORD_TOKEN, DISCORD_BOT_ID)');
  } else {
    fail(`DM routing prerequisites missing: ${dmMissing.join(', ')}`);
    errors.push(...dmMissing.map((name) => `missing:${name}`));
  }

  if (options.voiceEnabled) {
    pass('VOICE_ENABLED is true');
  } else {
    fail('VOICE_ENABLED is not true (voice runtime will stay disabled)');
    errors.push('missing:VOICE_ENABLED=true');
  }

  const voiceConfigMissing = [];
  if (!options.guildId) voiceConfigMissing.push('VOICE_TARGET_GUILD_ID');
  if (!options.targetUserId) voiceConfigMissing.push('VOICE_TARGET_USER_ID');
  if (!options.deepgramApiKey) voiceConfigMissing.push('DEEPGRAM_API_KEY');

  if (voiceConfigMissing.length === 0) {
    pass('Voice target + STT prerequisites present');
  } else {
    fail(`Voice prerequisites missing: ${voiceConfigMissing.join(', ')}`);
    errors.push(...voiceConfigMissing.map((name) => `missing:${name}`));
  }

  const tts = evaluateTtsProviderReadiness(options);
  if (tts.ready) {
    pass(`TTS connector prerequisites present (preferred=${tts.preferredProvider})`);
  } else {
    for (const issue of tts.issues) {
      fail(issue);
      errors.push(`tts:${issue}`);
    }
  }
  for (const warningMessage of tts.warnings) {
    warn(warningMessage);
    warnings.push(warningMessage);
  }

  const installedBackends = detectInstalledOpusBackends();
  if (installedBackends.length > 0) {
    const ordered = OPUS_BACKEND_PRIORITY.filter((backend) => installedBackends.includes(backend));
    const preferred = ordered[0] ?? installedBackends[0];
    pass(`Opus package(s) installed: ${installedBackends.join(', ')} (preferred active candidate: ${preferred})`);
    if (preferred !== '@discordjs/opus') {
      warn('Native backend @discordjs/opus is not installed; using JS fallback may increase CPU usage');
      warnings.push('native-opus-missing');
    }
  } else {
    fail('No Opus backend package detected (@discordjs/opus preferred, opusscript fallback)');
    errors.push('missing:opus-backend-package');
  }

  const prismResult = await checkPrismOpusDecoder();
  if (prismResult.available) {
    pass(`prism-media decoder instantiation succeeded${prismResult.backend ? ` (backend=${prismResult.backend})` : ''}`);
  } else {
    fail(`prism-media decoder instantiation failed: ${prismResult.error}`);
    errors.push('failed:prism-opus-decoder');
  }

  return {
    errors,
    warnings,
  };
}

async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function discordGet(path, token, timeoutMs) {
  const response = await fetchWithTimeout(`${DISCORD_API_BASE}${path}`, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Bot ${token}`,
    },
  }, timeoutMs);

  const text = await response.text();
  let payload = {};
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(`Discord API ${path} parse failure: ${text.slice(0, 200)}`);
    }
  }

  if (!response.ok) {
    const apiMessage = trimString(payload?.message) || `HTTP ${response.status}`;
    throw new Error(`Discord API ${path} failed (${response.status}): ${apiMessage}`);
  }

  return payload;
}

async function runLiveChecks(options) {
  const errors = [];
  const warnings = [];

  if (!options.token) {
    fail('Cannot run --live checks without DISCORD_TOKEN');
    return {
      errors: ['missing:DISCORD_TOKEN'],
      warnings,
    };
  }

  try {
    const me = await discordGet('/users/@me', options.token, options.timeoutMs);
    const username = [trimString(me?.username), trimString(me?.discriminator)].filter(Boolean).join('#');
    pass(`Discord bot token validated via /users/@me (${username || trimString(me?.id) || 'unknown'})`);
  } catch (error) {
    fail(toErrorMessage(error));
    errors.push('live:/users/@me');
    return { errors, warnings };
  }

  if (options.dmChannelId) {
    try {
      const channel = await discordGet(`/channels/${options.dmChannelId}`, options.token, options.timeoutMs);
      const type = Number(channel?.type);
      if (![1, 3].includes(type)) {
        throw new Error(`Channel ${options.dmChannelId} is not a DM channel (type=${type})`);
      }
      pass(`DM channel check passed (${options.dmChannelId}, type=${type})`);
    } catch (error) {
      fail(toErrorMessage(error));
      errors.push('live:dm-channel');
    }
  } else {
    warn('Skipping DM channel live check (set DISCORD_SMOKE_DM_CHANNEL_ID or --dm-channel-id)');
    warnings.push('live:missing-dm-channel-id');
  }

  if (options.voiceChannelId) {
    try {
      const channel = await discordGet(`/channels/${options.voiceChannelId}`, options.token, options.timeoutMs);
      const type = Number(channel?.type);
      if (![2, 13].includes(type)) {
        throw new Error(`Channel ${options.voiceChannelId} is not a voice/stage channel (type=${type})`);
      }
      if (options.guildId && trimString(channel?.guild_id) !== options.guildId) {
        throw new Error(`Voice channel guild mismatch: expected ${options.guildId}, got ${trimString(channel?.guild_id) || 'unknown'}`);
      }
      pass(`Voice channel check passed (${options.voiceChannelId}, type=${type})`);
    } catch (error) {
      fail(toErrorMessage(error));
      errors.push('live:voice-channel');
    }
  } else {
    warn('Skipping voice channel live check (set DISCORD_SMOKE_VOICE_CHANNEL_ID or --voice-channel-id)');
    warnings.push('live:missing-voice-channel-id');
  }

  if (options.guildId && options.targetUserId) {
    try {
      await discordGet(`/guilds/${options.guildId}/members/${options.targetUserId}`, options.token, options.timeoutMs);
      pass(`Target voice user membership validated (${options.targetUserId} in guild ${options.guildId})`);
    } catch (error) {
      fail(`Target voice user membership check failed: ${toErrorMessage(error)}`);
      errors.push('live:target-user-membership');
    }
  } else {
    warn('Skipping target user membership live check (missing guild or target user id)');
    warnings.push('live:missing-target-membership-inputs');
  }

  return { errors, warnings };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  info(`Mode: ${options.dryRun ? 'dry-run (no Discord API calls)' : 'live (read-only Discord API calls)'}`);
  info(`Failure behavior: ${options.strict ? 'strict (non-zero on failed readiness)' : 'report-only (always exit 0)'}`);

  const readiness = await evaluateReadiness(options);
  const live = options.dryRun
    ? { errors: [], warnings: [] }
    : await runLiveChecks(options);

  const failures = [...readiness.errors, ...live.errors];
  const warningCount = readiness.warnings.length + live.warnings.length;

  if (failures.length === 0) {
    pass('Discord DM + voice readiness checks passed');
  } else {
    fail(`Discord DM + voice readiness checks found ${failures.length} issue(s)`);
  }
  info(`Summary: failures=${failures.length}, warnings=${warningCount}`);

  if (failures.length > 0 && options.strict) {
    process.exit(1);
  }
}

try {
  await main();
} catch (error) {
  fail(toErrorMessage(error));
  process.exit(1);
}
