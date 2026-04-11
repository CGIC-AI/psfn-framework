import type { GatewayMethodRuntime } from './types.js';
import { registerLLMMethods } from './llm.js';
import { registerDiscordMethods } from './discord.js';
import { registerConfirmationMethods } from './confirmation.js';
import { registerSessionHmacMethods } from './session-hmac.js';
import { registerNotifyMethods } from './notify.js';
import { registerRuntimeHealthMethods } from './runtime-health.js';
import { registerWebMethods } from './web.js';
import { registerShellMethods } from './shell.js';
import { registerShardBackendMethods } from './shard-backends.js';
import { registerVaultMethods } from './vault.js';
import { registerFilesystemMethods } from './fs.js';
import { registerGitMethods } from './git.js';
import { registerBeadsMethods } from './beads.js';
import { registerImageMethods } from './image.js';

export function registerGatewayMethods(runtime: GatewayMethodRuntime): void {
  registerLLMMethods(runtime);
  registerDiscordMethods(runtime);
  registerConfirmationMethods(runtime);
  registerSessionHmacMethods(runtime);
  registerNotifyMethods(runtime);
  registerRuntimeHealthMethods(runtime);
  registerWebMethods(runtime);
  registerShellMethods(runtime);
  registerShardBackendMethods(runtime);
  registerVaultMethods(runtime);
  registerFilesystemMethods(runtime);
  registerGitMethods(runtime);
  registerBeadsMethods(runtime);
  registerImageMethods(runtime);
}
