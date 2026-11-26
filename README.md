# Take Three

Take Three is an early, local-first browser screen recorder that can upload
recordings to SharePoint or Google Drive.

**Prototype:** Advanced editing and MP4 export are not implemented.
Cloud uploads require your own OAuth app registrations and provider access.

## What works today

- Record a screen or window with an optional microphone and a three-second countdown.
- Review a take and save it to a local browser library.
- Trim the beginning and end into a new WebM copy while keeping the original.
- Cover or blur screen areas in a new local copy before sharing.
- Generate searchable, timestamped transcripts on-device and jump to matching moments.
- Export the entire library as a ZIP backup with recordings and metadata.
- Download recordings as WebM, delete them, or upload a custom thumbnail.
- Use floating recording controls in browsers that support Document Picture-in-Picture.
- Upload saved WebM recordings to Google Drive or a SharePoint document library.

Recordings and thumbnails are stored in the browser's IndexedDB, not in an
account or cloud backup. Clearing browser data, using private browsing, or
running out of storage can remove or prevent saving recordings. Download
anything you want to keep. Screen and audio capture support varies by browser,
operating system, and the source selected. A floating control window may
appear when capturing the entire display.

Use **Backup library** to download one ZIP containing each saved WebM plus a
`manifest.json` with titles, dates, thumbnails, transcripts, and upload links.
The backup is created in the browser and is not uploaded anywhere.

Transcription runs in your browser using Whisper Small. The first transcription
downloads roughly 250 MB of model files from Hugging Face; later use can reuse
the browser's cached copy. Recording audio is not sent to a transcription service.
Processing can take longer than with the earlier smaller model, and a recording
needs an audio track for transcription. Use **Regenerate** to update an existing
transcript.

Trimming also runs in the browser. It re-encodes the selected section in
real time, so the original remains unchanged and output quality may differ
slightly. Frame timing can shift slightly at the cut points.

Redaction masks are fixed to the same screen areas throughout the clip; they
do not track moving content. Solid covers are baked into the exported video.
Blur is cosmetic and may not fully hide text or other sensitive details.

## Run locally

Use Node.js 24 and npm. The app requires a secure context for screen capture;
`localhost` is supported.

```bash
git clone https://github.com/danstanau/take-three.git
cd take-three
npm ci
npm run dev
```

Open the local URL printed by Vite. Run `npm run build` to type-check and create
a production build, then `npm run preview` to serve that build locally.

## Build the macOS app

On macOS, run `npm run build:mac` to create a DMG in `release/`. The build uses
the current Mac's architecture (Apple Silicon or Intel). The app is unsigned;
macOS may require you to approve it in Privacy & Security the first time you
open it. Screen recording and microphone access are granted through macOS
privacy prompts. The app serves its bundled files at `http://localhost:5173`.
On macOS 15
and later, macOS provides the screen and window picker; older releases use a
basic source picker. System audio availability varies by macOS version.

## Set up cloud uploads

Enter provider details in **Settings → Cloud services** at runtime, then choose
**Connect**. Use **Save settings** to keep them without connecting. Settings
are stored locally in the app or browser, including the Google desktop client
secret, without encryption. Do not enter a confidential web or server secret.
Provider tokens are held in memory only.

### SharePoint

1. In Microsoft Entra, register separate app registrations for the browser and
   macOS app. For the browser app, add `http://localhost:5173` under
   **Single-page applications**, or use the exact origin where you host Take
   Three. For the macOS app, use a public client app registration and enable
   **Allow public client flows**. The macOS app uses Microsoft device
   authorization and does not require a callback redirect URI.
2. Under Microsoft Graph delegated permissions, add `Sites.ReadWrite.All` and
   obtain any required administrator consent. This permission allows access to
   sites the signed-in user can access; it does not bypass their permissions.
3. Enter the application (client) ID and directory (tenant) ID in settings.
4. Open settings, connect SharePoint, and, on macOS, enter the code displayed
   in Take Three on the Microsoft sign-in page. It is not an Authenticator code.
   Enter a site URL such as
   `https://company.sharepoint.com/sites/team`. Uploads go to the root of that
   site's **default** document library. The account needs write permission there.

### Google Drive

1. In Google Cloud, enable the Google Drive API and configure the OAuth consent
   screen. Add your account as a test user if the app is in testing mode.
2. For the macOS app, create a **Desktop app** OAuth client. For the browser
   app, create a **Web application** OAuth client and add
   `http://localhost:5173` to its authorized JavaScript origins, or use your
   hosted app's exact origin.
3. Enter the client ID in settings; on macOS, also enter the generated desktop
   client secret. Desktop OAuth clients are public clients and their secrets
   cannot be kept confidential. Connect Google Drive. Uploads go to the root of
   the signed-in user's My Drive.

The app requests Google's `drive.file` scope, which grants access to files
created or opened by the app rather than the whole Drive. Google may require
OAuth app verification before external users can use an app in production.
The browser app loads Google's Identity Services script for sign-in. The desktop
app opens the system browser; Google sign-in uses a temporary loopback callback
with PKCE, while Microsoft sign-in uses a device code.
Provider tokens are kept in memory for the current session; disconnecting or reloading
removes the app's active connection. Disconnecting does not revoke prior
consent in the provider's account settings.

Select a saved recording and choose a provider under **Publish to**. Google
Drive appears there only while connected; connect it in settings. Uploads
are sent directly from the browser in chunks, and links are saved with the
local recording. SharePoint uploads also request an anyone-with-the-link,
view-only sharing link, without removing existing permissions. Anyone with
that link can view the file without signing in. Your SharePoint administrator
may disable anonymous sharing; if link creation fails, the upload remains
available and you can retry without uploading again. Google Drive links use
the destination's existing access rules. For older uploads without saved
SharePoint item IDs, open the file in SharePoint to create a sharing link.
If the browser closes or a
network error interrupts an upload, the app cannot resume it; check the
destination for an existing file before retrying. Repeated uploads create
separate files.

## Roadmap

Advanced editing and more reliable audio and browser support are future work.

For a Rust experiment, keep the React interface and first build a small Rust
service using Axum for provider integrations. A later FFmpeg worker could handle
rendering and trimming, while Tauri is an option if a native desktop shell
becomes useful. Neither is required to run the current app.

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE).
