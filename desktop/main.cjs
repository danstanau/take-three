const { app, BrowserWindow, desktopCapturer, dialog, ipcMain, session, shell } = require("electron");
const { createDisplayMediaHandler } = require("./screen-capture.cjs");
const { connectCloud } = require("./oauth.cjs");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const APP_ORIGIN = "http://localhost:5173";
const APP_PORT = 5173;
const MEDIA_PERMISSIONS = new Set(["media", "display-capture"]);
const DIST_DIR = app.isPackaged
  ? path.join(process.resourcesPath, "dist")
  : path.join(__dirname, "..", "dist");
const MIME_TYPES = {
  ".css": "text/css",
  ".html": "text/html",
  ".ico": "image/x-icon",
  ".js": "text/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

let mainWindow;
let localServer;
let cloudConnecting = false;

function serveApp() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((request, response) => {
      let pathname;
      try {
        pathname = decodeURIComponent(new URL(request.url || "/", APP_ORIGIN).pathname);
      } catch {
        response.writeHead(400).end("Bad request");
        return;
      }

      const requestedPath = pathname === "/" ? "/index.html" : pathname;
      const filePath = path.resolve(DIST_DIR, `.${requestedPath}`);
      if (filePath !== DIST_DIR && !filePath.startsWith(`${DIST_DIR}${path.sep}`)) {
        response.writeHead(403).end("Forbidden");
        return;
      }

      fs.readFile(filePath, (error, contents) => {
        if (error) {
          if (error.code !== "ENOENT") console.error("Could not read app file:", error);
          response.writeHead(error.code === "ENOENT" ? 404 : 500).end("Could not load app file");
          return;
        }
        response.writeHead(200, {
          "Content-Type": MIME_TYPES[path.extname(filePath)] || "application/octet-stream",
          "X-Content-Type-Options": "nosniff",
        });
        response.end(contents);
      });
    });

    server.once("error", reject);
    server.listen(APP_PORT, "localhost", () => resolve(server));
  });
}

function isAppUrl(value) {
  try {
    return new URL(value).origin === APP_ORIGIN;
  } catch {
    return false;
  }
}

function isSignInUrl(value) {
  try {
    const { hostname, protocol } = new URL(value);
    return protocol === "https:" && (
      hostname === "accounts.google.com" ||
      hostname.endsWith(".google.com") ||
      hostname === "login.microsoftonline.com" ||
      hostname.endsWith(".login.microsoftonline.com") ||
      hostname === "login.live.com"
    );
  } catch {
    return false;
  }
}

function openExternal(url) {
  if (new URL(url).protocol !== "https:") return;
  shell.openExternal(url).catch((error) => console.error("Could not open external URL:", error));
}

async function createWindow() {
  if (!localServer) localServer = await serveApp();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.focus();
    return;
  }

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 850,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isAppUrl(url) || isSignInUrl(url)) return { action: "allow" };
    openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (isAppUrl(url) || isSignInUrl(url)) return;
    event.preventDefault();
    openExternal(url);
  });
  mainWindow.on("closed", () => {
    mainWindow = undefined;
  });

  await mainWindow.loadURL(APP_ORIGIN);
}

function reportStartupError(error) {
  console.error("Could not start Take Three:", error);
  dialog.showErrorBox(
    "Take Three could not start",
    `The local app server could not start on port ${APP_PORT}.\n\n${error.message}`,
  );
  app.quit();
}

app.whenReady().then(() => {
  ipcMain.handle("cloud:connect", async (event, config) => {
    if (!mainWindow || event.sender !== mainWindow.webContents ||
        event.senderFrame !== mainWindow.webContents.mainFrame || !isAppUrl(event.senderFrame.url)) {
      throw new Error("Cloud sign-in is only available from the Take Three app.");
    }
    if (cloudConnecting) throw new Error("A cloud sign-in is already in progress.");
    cloudConnecting = true;
    try {
      return await connectCloud(config, (url) => shell.openExternal(url), fetch, (code) => {
        if (!event.sender.isDestroyed()) event.sender.send("cloud:device-code", code);
      });
    } finally {
      cloudConnecting = false;
    }
  });
  session.defaultSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin, details) => {
    if (!isAppUrl(requestingOrigin)) return false;
    return permission === "display-capture" ||
      (permission === "media" && details.mediaType === "audio");
  });
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const origin = details.securityOrigin || details.requestingUrl;
    const mediaTypes = details.mediaTypes || [];
    const allowed = permission === "display-capture" ||
      (permission === "media" && mediaTypes.length > 0 && mediaTypes.every((type) => type === "audio"));
    callback(MEDIA_PERMISSIONS.has(permission) && allowed && isAppUrl(origin));
  });
  session.defaultSession.setDisplayMediaRequestHandler(
    createDisplayMediaHandler({ desktopCapturer, dialog, isAppUrl }),
    { useSystemPicker: true },
  );
  return createWindow();
}).catch(reportStartupError);

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow().catch(reportStartupError);
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  localServer?.close();
});
