import type { AgentTool } from '../../../boundary/pi-agent/index.js';
import { createBeadsTool } from '../../../boundary/integrations/beads/tools.js';
import { createFsTool } from '../../../boundary/integrations/filesystem/tools.js';
import { createRepoTool } from '../../../boundary/integrations/git/tools.js';
import { createJournalTool } from '../../../boundary/integrations/journal/tools.js';
import { createAutomataBusTool } from '../../../faculties/automata/bus/worker-access.js';
import { createMcpTool } from '../../../boundary/integrations/mcp/tools.js';
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
import { createLetterTool } from '../../tools/letter.js';
import { createOrientTool } from '../../../faculties/core-memory/tools.js';
import { createMemoryTool } from '../../../faculties/memory/tools.js';
import { createScratchpadTool } from '../../../faculties/memory/tools/scratchpad.js';
import { createNorthStarTool } from '../../../faculties/north-star/tools.js';
import { createSkillTool } from '../../../faculties/skills/tools.js';
import { createSubagentTool } from '../../../faculties/subagents/tools.js';
import { createWikiTool } from '../../../faculties/wiki/tools.js';
import { createPublicationTool } from '../../cogsec/disclosure/publication-tool.js';
import { createGenerateImageTool, createSelfieTool } from '../../../primitives/images/tools.js';
import { createResponseControlTool } from '../no-reply-tool.js';
import { createToolSearchTool, createToolsetTool } from '../substrate-agent/adaptive-tools-runtime.js';
import { INTAKE_FIREWALL_OFF_SELF_AUTHORED_MUTATION_RUNTIME } from '../../session/intake-sink-gating.js';
import type { SensitivityLevel } from '../../../system/trust/types.js';

function testBound(value: string): number {
  return Number.parseInt(value, 10);
}

function testSensitivity(value: SensitivityLevel): SensitivityLevel {
  return value;
}

export function createProviderFactoryToolCatalog(): AgentTool<any>[] {
  const inert = {} as never;
  const automataBus = createAutomataBusTool({
    access: {
      identity: {
        companionId: 'companion-public-example',
        audience: 'eligible-automata',
        maxSensitivity: testSensitivity('personal'),
      },
      bounds: {
        maxQueryChars: testBound('100'),
        maxTextChars: testBound('200'),
        maxArrayItems: testBound('8'),
        maxSearchResults: testBound('8'),
        maxRunResults: testBound('16'),
        maxBriefingChars: testBound('200'),
        maxBriefingItems: testBound('4'),
        maxToolResultChars: testBound('1000'),
      },
      port: {
        isClassEligible: () => true,
        brief: inert,
        search: inert,
        append: inert,
        correct: inert,
        handoff: inert,
        runs: inert,
        inspect: inert,
      },
    },
    scope: {
      companionId: 'companion-public-example',
      runId: 'run-public-example',
      taskId: 'task-public-example',
      automatonClass: 'subagent.bounded',
      audience: 'eligible-automata',
      maxSensitivity: testSensitivity('personal'),
    },
  });
  return [
    createToolSearchTool(inert), createToolsetTool(inert),
    createResponseControlTool(() => null), createFsTool(inert), createRepoTool(inert),
    createShellTool(inert), createWebTool(inert), createWorldTool(inert, inert),
    createMcpTool({ gateway: inert }),
    createAnalysisWorkbenchTool(inert), createOrientTool(inert), createIdentityTool(inert, {
      intake: INTAKE_FIREWALL_OFF_SELF_AUTHORED_MUTATION_RUNTIME,
    }),
    createMemoryTool(inert, inert), automataBus, createScratchpadTool(inert), createContactTool(inert, {
      intake: INTAKE_FIREWALL_OFF_SELF_AUTHORED_MUTATION_RUNTIME,
    }),
    createSessionTool(inert), createLetterTool(inert), createSelfStatusTool(inert), createSystemTool(inert),
    createSkillTool(inert), createWikiTool(inert, {
      intake: INTAKE_FIREWALL_OFF_SELF_AUTHORED_MUTATION_RUNTIME,
    }), createScheduleTool(inert),
    createNorthStarTool(inert), createBeadsTool(inert), createNotifyTool(inert),
    createGenerateImageTool(inert), createSelfieTool(inert), createSubagentTool(inert),
    createVaultTool(inert), createJournalTool(inert), createPublicationTool(inert),
  ];
}
