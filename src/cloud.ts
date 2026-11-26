import { BrowserCacheLocation, PublicClientApplication } from "@azure/msal-browser";

export type Provider = "SharePoint" | "Google Drive";
export type UploadResult = {
  provider: Provider;
  url: string;
  name: string;
  driveId?: string;
  itemId?: string;
  shareUrl?: string;
};
export type UploadProgress = (percent: number) => void;

const GOOGLE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const GRAPH_SCOPE = "https://graph.microsoft.com/Sites.ReadWrite.All";
const GRAPH = "https://graph.microsoft.com/v1.0";
const GOOGLE_CHUNK = 8 * 1024 * 1024;
const GRAPH_CHUNK = 10 * 1024 * 1024;

type GoogleTokenResponse = {
  access_token?: string;
  scope?: string;
  error?: string;
  error_description?: string;
};

declare global {
  interface Window {
    google?: {
      accounts: {
        oauth2: {
          initTokenClient: (config: {
            client_id: string;
            scope: string;
            callback: (response: GoogleTokenResponse) => void;
            error_callback: (error: { type: string }) => void;
          }) => { requestAccessToken: () => void };
        };
      };
    };
  }
}

export class CloudHttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export async function connectMicrosoft(clientId: string, tenantId: string, onDeviceCode?: (code: string) => void): Promise<string> {
  if (!clientId || !tenantId) {
    throw new Error("Enter your Microsoft application and tenant IDs in Settings.");
  }
  if (window.takeThreeDesktop) {
    return window.takeThreeDesktop.connect({ provider: "SharePoint", clientId, tenantId }, onDeviceCode);
  }
  const client = new PublicClientApplication({
    auth: {
      clientId,
      authority: `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}`,
      redirectUri: window.location.origin,
    },
    cache: { cacheLocation: BrowserCacheLocation.MemoryStorage },
  });
  await client.initialize();
  const result = await client.loginPopup({ scopes: [GRAPH_SCOPE] });
  if (!result.accessToken) throw new Error("Microsoft did not return an access token.");
  return result.accessToken;
}

export function connectGoogle(clientId: string, clientSecret: string): Promise<string> {
  if (!clientId) {
    return Promise.reject(new Error("Enter your Google client ID in Settings."));
  }
  if (window.takeThreeDesktop) {
    if (!clientSecret) return Promise.reject(new Error("Enter your Google desktop client secret in Settings."));
    return window.takeThreeDesktop.connect({ provider: "Google Drive", clientId, clientSecret });
  }
  if (!window.google?.accounts.oauth2) {
    return Promise.reject(new Error("Google sign-in is unavailable. Check your connection and reload the page."));
  }
  return new Promise((resolve, reject) => {
    const client = window.google!.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: GOOGLE_SCOPE,
      callback: (response) => {
        if (response.error || !response.access_token) {
          reject(new Error(response.error_description || response.error || "Google did not return an access token."));
        } else if (!response.scope?.split(" ").includes(GOOGLE_SCOPE)) {
          reject(new Error("Google Drive access was not granted."));
        } else {
          resolve(response.access_token);
        }
      },
      error_callback: (error) => reject(new Error(`Google sign-in failed: ${error.type}.`)),
    });
    client.requestAccessToken();
  });
}

function filename(title: string): string {
  const base = title.replace(/[\\/:*?"<>|#%&{}~\u0000-\u001f]/g, "-").trim().replace(/\.+$/, "");
  return `${base || "Recording"}.webm`;
}

async function checkResponse(response: Response, action: string): Promise<void> {
  if (response.ok) return;
  let detail = "";
  const text = await response.text();
  try {
    const body: { error?: { message?: string } } = JSON.parse(text);
    detail = body.error?.message || "";
  } catch {
    // Some upload endpoints return non-JSON errors.
  }
  const reconnect = response.status === 401 ? " Reconnect the service and try again." : "";
  throw new CloudHttpError(`${action} failed (${response.status}).${detail ? ` ${detail}` : ""}${reconnect}`, response.status);
}

function secureUrl(value: string | null | undefined, description: string): string {
  if (!value) throw new Error(`${description} was missing from the provider response.`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${description} was invalid.`);
  }
  if (url.protocol !== "https:") throw new Error(`${description} was invalid.`);
  return url.href;
}

function graphSitePath(siteUrl: string): string {
  let site: URL;
  try {
    site = new URL(siteUrl);
  } catch {
    throw new Error("Enter a full SharePoint site URL, such as https://company.sharepoint.com/sites/team.");
  }
  if (site.protocol !== "https:" || !site.hostname.endsWith(".sharepoint.com") || site.port || site.username || site.password) {
    throw new Error("Enter an HTTPS SharePoint site URL ending in sharepoint.com.");
  }
  const path = site.pathname.split("/").filter(Boolean).map((part) => encodeURIComponent(decodeURIComponent(part))).join("/");
  return path ? `${site.hostname}:/${path}` : `${site.hostname}:/`;
}

export async function uploadSharePoint(
  token: string,
  siteUrl: string,
  title: string,
  blob: Blob,
  progress: UploadProgress,
): Promise<UploadResult> {
  if (!blob.size) throw new Error("This recording is empty and cannot be uploaded.");
  const headers = { Authorization: `Bearer ${token}` };
  const siteResponse = await fetch(`${GRAPH}/sites/${graphSitePath(siteUrl)}`, { headers });
  await checkResponse(siteResponse, "Finding the SharePoint site");
  const site: { id?: string } = await siteResponse.json();
  if (!site.id) throw new Error("SharePoint did not return a site ID.");

  const driveResponse = await fetch(`${GRAPH}/sites/${encodeURIComponent(site.id)}/drive`, { headers });
  await checkResponse(driveResponse, "Finding the SharePoint document library");
  const drive: { id?: string } = await driveResponse.json();
  if (!drive.id) throw new Error("SharePoint did not return a document library.");

  const name = filename(title);
  const sessionResponse = await fetch(
    `${GRAPH}/drives/${encodeURIComponent(drive.id)}/root:/${encodeURIComponent(name)}:/createUploadSession`,
    {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ item: { "@microsoft.graph.conflictBehavior": "rename", name } }),
    },
  );
  await checkResponse(sessionResponse, "Creating the SharePoint upload");
  const session: { uploadUrl?: string } = await sessionResponse.json();
  const uploadUrl = secureUrl(session.uploadUrl, "SharePoint upload URL");

  let start = 0;
  while (start < blob.size) {
    const end = Math.min(start + GRAPH_CHUNK, blob.size);
    const response = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Range": `bytes ${start}-${end - 1}/${blob.size}` },
      body: blob.slice(start, end),
    });
    if (response.status === 202) {
      const state: { nextExpectedRanges?: string[] } = await response.json();
      const next = Number(state.nextExpectedRanges?.[0]?.split("-")[0]);
      if (!Number.isSafeInteger(next) || next <= start || next > end || next >= blob.size) {
        throw new Error("SharePoint returned an unexpected upload position.");
      }
      start = next;
      progress(Math.floor((start / blob.size) * 100));
      continue;
    }
    await checkResponse(response, "SharePoint upload");
    const item: { id?: string; webUrl?: string; name?: string } = await response.json();
    if (end !== blob.size) throw new Error("SharePoint ended the upload unexpectedly.");
    progress(100);
    return {
      provider: "SharePoint",
      url: secureUrl(item.webUrl, "SharePoint file URL"),
      name: item.name || name,
      driveId: drive.id,
      itemId: item.id,
    };
  }
  throw new Error("SharePoint did not confirm the completed upload.");
}

export async function createSharePointLink(token: string, driveId: string, itemId: string): Promise<string> {
  const response = await fetch(
    `${GRAPH}/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}/createLink`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ type: "view", scope: "anonymous", retainInheritedPermissions: true }),
    },
  );
  await checkResponse(response, "Creating the SharePoint sharing link");
  const permission: { link?: { webUrl?: string; scope?: string; type?: string } } = await response.json();
  if (permission.link?.scope !== "anonymous" || permission.link.type !== "view") {
    throw new Error("SharePoint did not confirm an anyone-with-the-link view permission.");
  }
  return secureUrl(permission.link.webUrl, "SharePoint sharing link");
}

export async function uploadGoogle(
  token: string,
  title: string,
  blob: Blob,
  progress: UploadProgress,
): Promise<UploadResult> {
  if (!blob.size) throw new Error("This recording is empty and cannot be uploaded.");
  const name = filename(title);
  const sessionResponse = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,webViewLink",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-Upload-Content-Type": "video/webm",
        "X-Upload-Content-Length": String(blob.size),
      },
      body: JSON.stringify({ name, mimeType: "video/webm" }),
    },
  );
  await checkResponse(sessionResponse, "Creating the Google Drive upload");
  const uploadUrl = secureUrl(sessionResponse.headers.get("Location"), "Google Drive upload URL");

  let start = 0;
  while (start < blob.size) {
    const end = Math.min(start + GOOGLE_CHUNK, blob.size);
    const response = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Type": "video/webm",
        "Content-Range": `bytes ${start}-${end - 1}/${blob.size}`,
      },
      body: blob.slice(start, end),
    });
    if (response.status === 308) {
      const range = response.headers.get("Range")?.match(/^bytes=0-(\d+)$/);
      const next = range ? Number(range[1]) + 1 : 0;
      if (!Number.isSafeInteger(next) || next <= start || next > end || next >= blob.size) {
        throw new Error("Google Drive returned an unexpected upload position.");
      }
      start = next;
      progress(Math.floor((start / blob.size) * 100));
      continue;
    }
    await checkResponse(response, "Google Drive upload");
    const item: { id?: string; name?: string; webViewLink?: string } = await response.json();
    if (end !== blob.size || !item.id) throw new Error("Google Drive did not confirm the completed upload.");
    progress(100);
    const url = item.webViewLink || `https://drive.google.com/file/d/${encodeURIComponent(item.id)}/view`;
    return { provider: "Google Drive", url: secureUrl(url, "Google Drive file URL"), name: item.name || name };
  }
  throw new Error("Google Drive did not confirm the completed upload.");
}
