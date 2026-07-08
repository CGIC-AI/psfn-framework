import type { SubstrateAgent } from '../../core/agent/substrate-agent.js';
import { JournalOps } from '../../boundary/integrations/journal/ops.js';
import { registerJournalTools } from '../../boundary/integrations/journal/runtime-wiring.js';
import { JournalAutoPublisher } from '../../boundary/integrations/journal/auto-publish.js';
import { resolvePersonalJournalDir } from '../../persistence/layout.js';
import { createComponentLogger } from '../../shared/logger.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';

const log = createComponentLogger('JournalRuntime');

export function registerMarkdownJournalTools(
  agentLoop: SubstrateAgent,
  workspaceRoot: string,
): JournalOps {
  const journalRoot = resolvePersonalJournalDir(workspaceRoot);
  const journalOps = new JournalOps(journalRoot);
  registerJournalTools(agentLoop, journalOps);
  log.info('Markdown journal tool enabled', { journalRoot });
  return journalOps;
}

export function createOptionalJournalAutoPublisher(
  workspaceRoot: string,
  config: SubstrateConfig,
): JournalAutoPublisher | undefined {
  if (!config.obsidianAutoPublish) {
    return undefined;
  }
  const journalRoot = resolvePersonalJournalDir(workspaceRoot);
  const publisher = new JournalAutoPublisher(new JournalOps(journalRoot));
  log.info('Journal auto-publish enabled for reflections', { journalRoot });
  return publisher;
}
