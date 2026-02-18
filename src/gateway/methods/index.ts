import type { GatewayMethodRuntime } from './types.js';
import { registerLLMMethods } from './llm.js';
import { registerDiscordMethods } from './discord.js';
import { registerWebMethods } from './web.js';
import { registerFilesystemMethods } from './fs.js';
import { registerGitMethods } from './git.js';

export function registerGatewayMethods(runtime: GatewayMethodRuntime): void {
  registerLLMMethods(runtime);
  registerDiscordMethods(runtime);
  registerWebMethods(runtime);
  registerFilesystemMethods(runtime);
  registerGitMethods(runtime);
}
