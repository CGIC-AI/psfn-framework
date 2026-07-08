export const HUB_WS_ENV_NAME = 'VITE_PSFN_SATELLITE_MOBILE_CHAT_APP_WS_URL';

export interface CompanionUiRuntimeConfig {
  hubWsUrl: string;
}

export function readCompanionUiRuntimeConfig(
  env: Pick<ImportMetaEnv, typeof HUB_WS_ENV_NAME> = import.meta.env,
): CompanionUiRuntimeConfig {
  const hubWsUrl = env[HUB_WS_ENV_NAME]?.trim();
  if (!hubWsUrl) {
    throw new Error(`${HUB_WS_ENV_NAME} is required`);
  }
  return { hubWsUrl };
}
