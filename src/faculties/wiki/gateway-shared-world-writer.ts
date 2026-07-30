import type { GatewaySystemDataWriterPort } from '../../boundary/gateway/system-data-writer.js';
import { SharedWorldWikiStore } from './store.js';
import type { WikiDocument, WikiDocumentUpsertInput } from './types.js';

export type SharedWorldWikiDocumentWriter = (
  siteId: string,
  input: WikiDocumentUpsertInput,
) => Promise<WikiDocument>;

/**
 * Create the agent-side adapter for a gateway-owned shared-world write. The
 * read-back proves that both processes see the same canonical system-data
 * volume before projection or proposal completion can continue.
 */
export function createGatewaySharedWorldWikiDocumentWriter(options: {
  systemDataDir: string;
  systemDataWriter: GatewaySystemDataWriterPort;
}): SharedWorldWikiDocumentWriter {
  return async (siteId, input) => {
    const result = await options.systemDataWriter.writeSystemData({
      kind: 'shared_world_wiki',
      operation: 'upsert_document',
      siteId,
      document: input,
    });
    if (!('kind' in result) || result.operation !== 'upsert_document') {
      throw new Error('Gateway shared-world wiki writer returned an invalid upsert response');
    }
    const documentId = input.id;
    const written = documentId
      ? new SharedWorldWikiStore(options.systemDataDir, siteId).get(documentId)
      : null;
    if (!written) {
      throw new Error(
        'Gateway wrote the shared-world wiki document, but the agent cannot read it. '
        + 'Verify the gateway and agent share the same system-data volume.',
      );
    }
    return written;
  };
}
