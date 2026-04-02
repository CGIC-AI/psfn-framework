import type { GatewayClient } from '../gateway/client.js';
import type { ShellOperations, ShellExecOptions } from './ops.js';
import type { ShellExecResult } from '../gateway/protocol.js';

export class GatewayShellOps implements ShellOperations {
  constructor(private readonly gateway: GatewayClient) {}

  async exec(
    command: string,
    args: string[] = [],
    options: ShellExecOptions = {},
  ): Promise<ShellExecResult> {
    return await this.gateway.shellExec(command, args, options);
  }
}
