/// <reference types="vite/client" />

interface Window {
  takeThreeDesktop?: {
    connect: (
      config:
        | { provider: "SharePoint"; clientId: string; tenantId: string }
        | { provider: "Google Drive"; clientId: string; clientSecret: string },
      onDeviceCode?: (code: string) => void,
    ) => Promise<string>;
  };
}
