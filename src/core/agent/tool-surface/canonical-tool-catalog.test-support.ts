import type { AgentTool } from '../../../boundary/pi-agent/index.js';
import { createBeadsTool } from '../../../boundary/integrations/beads/tools.js';
import { createFsTool } from '../../../boundary/integrations/filesystem/tools.js';
import { createRepoTool } from '../../../boundary/integrations/git/tools.js';
import { createJournalTool } from '../../../boundary/integrations/journal/tools.js';
import { createShellTool } from '../../../boundary/integrations/shell/tools.js';
import { createVaultTool } from '../../../boundary/integrations/vault/tools.js';
import { createWebTool } from '../../../boundary/integrations/web/tools.js';
import { createWorldTool } from '../../../boundary/integrations/world/tools.js';
import { createContactTool } from '../../contacts/tools.js';
import { createIdentityTool } from '../../identity/prompt-tools.js';
import { createScheduleTool } from '../../scheduler/schedule-tool.js';
import { createAnalysisWorkbenchTool } from '../../tools/analysis-workbench/tools.js';
import { createSystemTool } from '../../tools/lifecycle.js';
import { createNotifyTool } from '../../tools/ntfy.js';
import { createSelfStatusTool } from '../../tools/self-status.js';
import { createSessionTool } from '../../tools/session.js';
import { createOrientTool } from '../../../faculties/core-memory/tools.js';
import { createMemoryTool } from '../../../faculties/memory/tools.js';
import { createScratchpadTool } from '../../../faculties/memory/tools/scratchpad.js';
import { createResearchLibraryTool } from '../../../faculties/memory/research-library/tools.js';
import { createNorthStarTool } from '../../../faculties/north-star/tools.js';
import { createSkillTool } from '../../../faculties/skills/tools.js';
import { createSubagentTool } from '../../../faculties/subagents/tools.js';
import { createWikiTool } from '../../../faculties/wiki/tools.js';
import { createGenerateImageTool, createSelfieTool } from '../../../primitives/images/tools.js';
import { createResponseControlTool } from '../no-reply-tool.js';
import { createToolSearchTool, createToolsetTool } from '../substrate-agent/adaptive-tools-runtime.js';

export function createProviderFactoryToolCatalog(): AgentTool<any>[] {
  const inert = {} as never;
  return [
    createToolSearchTool(inert), createToolsetTool(inert),
    createResponseControlTool(() => null), createFsTool(inert), createRepoTool(inert),
    createShellTool(inert), createWebTool(inert), createWorldTool(inert, inert),
    createAnalysisWorkbenchTool(inert), createOrientTool(inert), createIdentityTool(inert),
    createMemoryTool(inert, inert), createScratchpadTool(inert), createContactTool(inert),
    createSessionTool(inert), createSelfStatusTool(inert), createSystemTool(inert),
    createSkillTool(inert), createWikiTool(inert), createScheduleTool(inert),
    createNorthStarTool(inert), createBeadsTool(inert), createNotifyTool(inert),
    createGenerateImageTool(inert), createSelfieTool(inert), createSubagentTool(inert),
    createVaultTool(inert), createJournalTool(inert),
    createResearchLibraryTool(inert, inert),
  ];
}
