import type { GatewayMethodRuntime } from './types.js';
import { registerLLMMethods } from './llm.js';
import { registerDiscordMethods } from './discord.js';
import { registerConfirmationMethods } from './confirmation.js';
import { registerSessionHmacMethods } from './session-hmac.js';
import { registerNotifyMethods } from './notify.js';
import { registerWebMethods } from './web.js';
import { registerShellMethods } from './shell.js';
import { registerFilesystemMethods } from './fs.js';
import { registerGitMethods } from './git.js';

export function registerGatewayMethods(runtime: GatewayMethodRuntime): void {
  registerLLMMethods(runtime);
  registerDiscordMethods(runtime);
  registerConfirmationMethods(runtime);
  registerSessionHmacMethods(runtime);
  registerNotifyMethods(runtime);
  registerWebMethods(runtime);
  registerShellMethods(runtime);
  registerFilesystemMethods(runtime);
  registerGitMethods(runtime);
}
