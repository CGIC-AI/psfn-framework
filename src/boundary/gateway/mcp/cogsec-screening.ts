import type { IntakeScreeningService } from '../../../core/cogsec/intake/screening.js';
import type { McpCogSecScreeningPort } from './broker.js';

export function createMcpCogSecScreeningPort(
  screeningFor: (companionId: string) => IntakeScreeningService | null,
): McpCogSecScreeningPort {
  function resolve(companionId: string): IntakeScreeningService {
    const screening = screeningFor(companionId);
    if (!screening) {
      throw new Error(`MCP CogSec screening is unavailable for companion '${companionId}'`);
    }
    return screening;
  }

  return {
    async screenStaticMetadata(input) {
      const screening = resolve(input.companionId);
      const result = await screening.screen(input.text, {
        sourceClass: 'mcp_tool_description',
        origin: { ref: `mcp:${input.serverId}:metadata:${input.sha256}` },
        scope: 'strict',
      });
      return {
        effectiveText: result.effectiveText,
        withheld: result.withheld,
      };
    },
    async screenDynamicOutput(input) {
      const screening = resolve(input.companionId);
      const result = await screening.screen(input.text, {
        sourceClass: 'tool_output',
        origin: { ref: `mcp:${input.serverId}:tool:${input.toolName}` },
        scope: 'strict',
      });
      return {
        effectiveText: result.effectiveText,
        withheld: result.withheld,
      };
    },
  };
}
