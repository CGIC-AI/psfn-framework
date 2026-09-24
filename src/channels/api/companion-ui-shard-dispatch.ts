import type { CompanionUiActionFrame } from '../../boundary/fleet-auth/companion-ui-action.js';
import type {
  ShardChatAuthor,
  ShardDirectoryPort,
} from '../../shared/contracts/shard-directory.js';
import type { CompanionId } from '../../shared/routing/companion-id.js';
import type { ApiCompanionUiShardActionRpcSuccess } from './types.js';

/**
 * Execute one already-authorized Companion UI `shards.*` frame against the
 * parent's live shard directory. Both authority paths share this switch: the
 * Hub path (fleet child capability + device attachment) and the operator-key
 * path (the key principal is the human authority, psfn-framework-m1is8). The
 * caller owns authorization; the directory re-checks the parent/shard tuple.
 */
export async function dispatchCompanionUiShardFrame(input: Readonly<{
  directory: ShardDirectoryPort;
  parentCompanionId: CompanionId;
  frame: CompanionUiActionFrame;
  author: ShardChatAuthor;
}>): Promise<ApiCompanionUiShardActionRpcSuccess> {
  const { directory, parentCompanionId, frame } = input;
  const body = frame.body as Record<string, unknown>;
  switch (frame.resource) {
    case 'shards.list':
      return { ok: true, response: directory.listShards(parentCompanionId) };
    case 'shards.history':
      return {
        ok: true,
        response: directory.readShardChatHistory(parentCompanionId, String(body.shardId)),
      };
    case 'shards.interact':
      return {
        ok: true,
        response: await directory.sendShardChat({
          parentCompanionId,
          shardId: String(body.shardId),
          requestId: frame.requestId,
          content: String(body.content),
          author: input.author,
        }),
      };
    case 'shards.interrupt':
      return {
        ok: true,
        response: directory.interruptShardChat({
          parentCompanionId,
          shardId: String(body.shardId),
          interactionId: String(body.interactionId),
        }),
      };
    default:
      throw new Error('non-shard Companion UI action');
  }
}
