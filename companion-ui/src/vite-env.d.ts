/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_PSFN_SATELLITE_MOBILE_CHAT_APP_WS_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
