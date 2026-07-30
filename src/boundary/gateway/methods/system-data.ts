import { parseSystemDataWriteRequest } from '../system-data-writer.js';
import type { GatewayMethodRuntime } from './types.js';

function summarizeSystemDataWrite(
  input: unknown,
  authenticatedCompanionId: string | undefined,
): Record<string, unknown> {
  try {
    const request = parseSystemDataWriteRequest(input);
    return {
      companionId: authenticatedCompanionId ?? '(unidentified)',
      kind: request.kind,
      ...(request.kind === 'owner_file' ? { ownerFile: request.ownerFile } : {}),
      ...(request.kind === 'tool_conformance'
        ? {
            ranAt: request.payload.ranAt,
            trigger: request.payload.trigger,
            resultCount: request.payload.results.length,
          }
        : {}),
      ...(request.kind === 'shared_world_wiki'
        ? { operation: request.operation, siteId: request.siteId }
        : {}),
    };
  } catch {
    // Audit summaries execute before the audited handler. They must never
    // throw, or a malformed privileged request would evade the audit record
    // that captures its eventual rejection.
    return {
      companionId: authenticatedCompanionId ?? '(unidentified)',
      invalidRequest: true,
    };
  }
}

export function registerSystemDataMethods(runtime: GatewayMethodRuntime): void {
  runtime.target.addMethod(
    'system.data.write',
    runtime.audited(
      'system.data.write',
      async (input: unknown) => {
        if (!runtime.authenticatedCompanionId()) {
          throw new Error('system.data.write requires an authenticated companion connection');
        }
        if (!runtime.systemDataWriter) {
          throw new Error('Gateway system-data writer is not configured');
        }
        return await runtime.systemDataWriter.writeSystemData(
          parseSystemDataWriteRequest(input),
        );
      },
      (input: unknown) => summarizeSystemDataWrite(
        input,
        runtime.authenticatedCompanionId(),
      ),
    ),
  );
}
