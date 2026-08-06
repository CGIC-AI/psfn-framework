import { gatewayOperationalParamDecoders } from './params/gateway.js';
import { llmMethodParamDecoders } from './params/llm.js';

export const gatewayMethodParamDecoders = {
  ...llmMethodParamDecoders,
  ...gatewayOperationalParamDecoders,
} as const;

export { agentMethodParamDecoders } from './params/agent.js';
