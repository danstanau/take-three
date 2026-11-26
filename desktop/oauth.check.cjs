const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { connectCloud } = require("./oauth.cjs");

test("Google desktop sign-in validates state and exchanges a PKCE code", async () => {
  let authorization;
  const token = await connectCloud(
    { provider: "Google Drive", clientId: "google-client", clientSecret: "desktop-secret" },
    async (url) => {
      authorization = new URL(url);
      const callback = new URL(authorization.searchParams.get("redirect_uri"));
      callback.searchParams.set("state", "wrong");
      callback.searchParams.set("code", "wrong-code");
      assert.equal((await fetch(callback)).status, 400);
      callback.searchParams.set("state", authorization.searchParams.get("state"));
      callback.searchParams.set("code", "valid-code");
      assert.equal((await fetch(callback)).status, 200);
    },
    async (url, options) => {
      assert.equal(url, "https://oauth2.googleapis.com/token");
      assert.equal(options.body.get("code"), "valid-code");
      assert.equal(options.body.get("client_secret"), "desktop-secret");
      assert.equal(
        crypto.createHash("sha256").update(options.body.get("code_verifier")).digest("base64url"),
        authorization.searchParams.get("code_challenge"),
      );
      return Response.json({ access_token: "access", scope: "https://www.googleapis.com/auth/drive.file" });
    },
  );
  assert.equal(token, "access");
});

test("Microsoft desktop sign-in uses device authorization and polls for a token", async () => {
  let verificationUrl;
  let polls = 0;
  const codes = [];
  const token = await connectCloud(
    { provider: "SharePoint", clientId: "client", tenantId: "tenant-id" },
    async (url) => {
      assert.deepEqual(codes, ["ABCD1234"]);
      verificationUrl = url;
    },
    async (url, options) => {
      if (url.endsWith("/devicecode")) {
        assert.equal(options.body.get("client_id"), "client");
        assert.equal(options.body.get("scope"), "https://graph.microsoft.com/Sites.ReadWrite.All");
        return Response.json({
          device_code: "device-code",
          user_code: "ABCD1234",
          verification_uri: "https://microsoft.com/devicelogin",
          expires_in: 60,
          interval: 0.001,
        });
      }
      assert.equal(url, "https://login.microsoftonline.com/tenant-id/oauth2/v2.0/token");
      assert.equal(options.body.get("device_code"), "device-code");
      polls += 1;
      if (polls === 1) return Response.json({ error: "authorization_pending" }, { status: 400 });
      return Response.json({ access_token: "microsoft-access" });
    },
    (code) => codes.push(code),
  );
  assert.equal(verificationUrl, "https://microsoft.com/devicelogin");
  assert.deepEqual(codes, ["ABCD1234"]);
  assert.equal(token, "microsoft-access");
});

test("Microsoft desktop sign-in rejects responses without a user code", async () => {
  let opened = false;
  await assert.rejects(connectCloud(
    { provider: "SharePoint", clientId: "client", tenantId: "tenant-id" },
    async () => { opened = true; },
    async () => Response.json({ device_code: "device-code", expires_in: 60, interval: 5 }),
  ), /Microsoft sign-in request failed/);
  assert.equal(opened, false);
});

test("rejects a Google response without the requested scope", async () => {
  await assert.rejects(connectCloud(
    { provider: "Google Drive", clientId: "client", clientSecret: "secret" },
    async (url) => {
      const authorization = new URL(url);
      const callback = new URL(authorization.searchParams.get("redirect_uri"));
      callback.searchParams.set("state", authorization.searchParams.get("state"));
      callback.searchParams.set("code", "code");
      await fetch(callback);
    },
    async () => Response.json({ access_token: "access", scope: "other" }),
  ), /access was not granted/);
});
