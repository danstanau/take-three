const crypto = require("node:crypto");
const http = require("node:http");

const SCOPES = {
  "Google Drive": "https://www.googleapis.com/auth/drive.file",
  SharePoint: "https://graph.microsoft.com/Sites.ReadWrite.All",
};

async function connectCloud(config, openExternal, fetchToken = fetch, showDeviceCode = () => {}) {
  if (!config || !Object.hasOwn(SCOPES, config.provider) ||
      typeof config.clientId !== "string" || !config.clientId.trim()) {
    throw new Error("Enter a valid provider and client ID.");
  }
  const google = config.provider === "Google Drive";
  if (google && (typeof config.clientSecret !== "string" || !config.clientSecret.trim())) {
    throw new Error("Enter the Google desktop client secret.");
  }
  if (!google && (typeof config.tenantId !== "string" || !/^[a-zA-Z0-9.-]+$/.test(config.tenantId))) {
    throw new Error("Enter a valid Microsoft tenant ID.");
  }
  if (!google) {
    const tenant = encodeURIComponent(config.tenantId.trim());
    const scope = SCOPES.SharePoint;
    const deviceResponse = await fetchToken(
      `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/devicecode`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: config.clientId.trim(),
          scope,
        }),
      },
    );
    const device = await deviceResponse.json();
    if (!deviceResponse.ok || !device.device_code || !device.user_code ||
        !Number.isFinite(device.expires_in) || device.expires_in <= 0 ||
        !Number.isFinite(device.interval) || device.interval <= 0) {
      throw new Error(device.error_description || device.error || `Microsoft sign-in request failed (${deviceResponse.status}).`);
    }

    const started = Date.now();
    showDeviceCode(device.user_code);
    await openExternal("https://microsoft.com/devicelogin");
    let interval = device.interval;
    const tokenUrl = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;

    while (Date.now() - started < device.expires_in * 1000) {
      const remaining = device.expires_in * 1000 - (Date.now() - started);
      await new Promise((resolve) => setTimeout(resolve, Math.min(interval * 1000, remaining)));
      if (Date.now() - started >= device.expires_in * 1000) break;
      const response = await fetchToken(tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: config.clientId.trim(),
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: device.device_code,
        }),
      });
      const result = await response.json();
      if (response.ok && result.access_token) return result.access_token;

      if (result.error === "authorization_pending") continue;
      if (result.error === "slow_down") {
        interval += 5;
        continue;
      }
      throw new Error(result.error_description || result.error || `Microsoft sign-in failed (${response.status}).`);
    }
    throw new Error("Microsoft sign-in timed out. Please try again.");
  }

  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const state = crypto.randomBytes(32).toString("base64url");
  const scope = SCOPES[config.provider];
  const host = google ? "127.0.0.1" : "localhost";
  const base = google
    ? "https://accounts.google.com/o/oauth2/v2/auth"
    : `https://login.microsoftonline.com/${encodeURIComponent(config.tenantId)}/oauth2/v2.0/authorize`;
  const tokenUrl = google
    ? "https://oauth2.googleapis.com/token"
    : `https://login.microsoftonline.com/${encodeURIComponent(config.tenantId)}/oauth2/v2.0/token`;

  let resolveCode;
  let rejectCode;
  const codePromise = new Promise((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    if (req.method !== "GET" || url.pathname !== "/callback" || url.searchParams.get("state") !== state) {
      res.writeHead(400).end("Invalid authorization response.");
      return;
    }
    const code = url.searchParams.get("code");
    const error = url.searchParams.get("error");
    res.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'",
    }).end(code && !error ? "Authorization received. You can return to Take Three." : "Authorization was not completed. You can return to Take Three.");
    if (error || !code) rejectCode(new Error(error ? `Sign-in failed: ${error}` : "Sign-in returned no authorization code."));
    else resolveCode(code);
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolve);
  });
  const redirectUri = `http://${host}:${server.address().port}/callback`;
  const authorize = new URL(base);
  authorize.search = new URLSearchParams({
    client_id: config.clientId.trim(),
    redirect_uri: redirectUri,
    response_type: "code",
    scope,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();

  const timeout = setTimeout(() => rejectCode(new Error("Sign-in timed out. Please try again.")), 5 * 60 * 1000);
  try {
    const [, code] = await Promise.all([openExternal(authorize.href), codePromise]);
    const body = new URLSearchParams({
      client_id: config.clientId.trim(),
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    });
    if (google) body.set("client_secret", config.clientSecret.trim());
    else body.set("scope", scope);
    const response = await fetchToken(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const result = await response.json();
    if (!response.ok || !result.access_token) {
      throw new Error(result.error_description || result.error || `Token request failed (${response.status}).`);
    }
    if (google && !result.scope?.split(" ").includes(scope)) {
      throw new Error("Google Drive access was not granted.");
    }
    return result.access_token;
  } finally {
    clearTimeout(timeout);
    server.close();
  }
}

module.exports = { connectCloud };
