import type { GatewayClient } from './client.js';
import type {
  GitCommitResult,
  GitDiffResult,
  GitOperations,
  GitStatusResult,
} from '../integrations/git/ops.js';
import type { WebFetchOperations } from '../integrations/web/ops.js';
import type { FilesystemReadOperations } from '../integrations/filesystem/ops.js';
import type { BeadsOperations } from '../integrations/beads/ops.js';
import type {
  BeadsActionResult,
  BeadsCloseParams,
  BeadsCreateParams,
  BeadsReadyParams,
  BeadsShowParams,
  BeadsSyncParams,
  BeadsUpdateParams,
  WebFetchLane,
} from './protocol.js';

export interface GatewayOpsPort {
  git: GitOperations;
  web: WebFetchOperations;
  filesystem: FilesystemReadOperations;
  beads: BeadsOperations;
}

export function createGatewayOpsPort(port: GatewayOpsPort): GatewayOpsPort {
  return {
    git: {
      status: (): GitStatusResult | Promise<GitStatusResult> => port.git.status(),
      diff: (opts?: { staged?: boolean }): GitDiffResult | Promise<GitDiffResult> => port.git.diff(opts),
      createBranch: (name: string, startPoint?: string): string | Promise<string> => port.git.createBranch(name, startPoint),
      applyPatch: (filePath: string, content: string): void | Promise<void> => port.git.applyPatch(filePath, content),
      commit: (message: string, intent: string, scope?: string): GitCommitResult | Promise<GitCommitResult> => (
        port.git.commit(message, intent, scope)
      ),
      openPR: (title: string, body: string, base?: string): string | Promise<string> => port.git.openPR(title, body, base),
    },
    web: {
      fetch: (url: string, options?: { lane?: WebFetchLane; prompt?: string }) => port.web.fetch(url, options),
    },
    filesystem: {
      read: (path: string) => port.filesystem.read(path),
      list: (glob?: string, maxEntries?: number) => port.filesystem.list(glob, maxEntries),
    },
    beads: {
      ready: (params?: BeadsReadyParams): Promise<BeadsActionResult> => port.beads.ready(params),
      show: (params: BeadsShowParams): Promise<BeadsActionResult> => port.beads.show(params),
      create: (params: BeadsCreateParams): Promise<BeadsActionResult> => port.beads.create(params),
      update: (params: BeadsUpdateParams): Promise<BeadsActionResult> => port.beads.update(params),
      close: (params: BeadsCloseParams): Promise<BeadsActionResult> => port.beads.close(params),
      sync: (params?: BeadsSyncParams): Promise<BeadsActionResult> => port.beads.sync(params),
    },
  };
}

export function createGatewayOpsPortFromClient(gateway: GatewayClient): GatewayOpsPort {
  return createGatewayOpsPort({
    git: {
      status: () => gateway.gitStatus(),
      diff: (opts?: { staged?: boolean }) => gateway.gitDiff(opts),
      createBranch: (name: string, startPoint?: string) => gateway.gitCreateBranch(name, startPoint),
      applyPatch: (filePath: string, content: string) => gateway.gitApplyPatch(filePath, content),
      commit: (message: string, intent: string, scope?: string) => gateway.gitCommit(message, intent, scope),
      openPR: (title: string, body: string, base?: string) => gateway.gitOpenPR(title, body, base),
    },
    web: {
      fetch: (url: string, options: { lane?: WebFetchLane; prompt?: string } = {}) => (
        gateway.webFetch(url, options.prompt, options.lane ?? 'default')
      ),
    },
    filesystem: {
      read: (path: string) => gateway.fsRead(path),
      list: (glob = '**/*', maxEntries = 200) => gateway.fsList(glob, maxEntries),
    },
    beads: {
      ready: (params: BeadsReadyParams = {}) => gateway.beadsReady(params),
      show: (params: BeadsShowParams) => gateway.beadsShow(params),
      create: (params: BeadsCreateParams) => gateway.beadsCreate(params),
      update: (params: BeadsUpdateParams) => gateway.beadsUpdate(params),
      close: (params: BeadsCloseParams) => gateway.beadsClose(params),
      sync: (params: BeadsSyncParams = {}) => gateway.beadsSync(params),
    },
  });
}
