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

Transcription runs in your browser using a small Whisper model. The first
transcription downloads the model from Hugging Face; later use can reuse the
browser's cached copy. Recording audio is not sent to a transcription service.
Processing speed depends on your device, and a recording needs an audio track
for transcription.

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

## Set up cloud uploads

Copy `.env.example` to `.env.local` and fill in the public client IDs for the
providers you want to use. Restart the Vite server after changing them. Do not
put client secrets in Vite environment variables: they are embedded in the
client application.

### SharePoint

1. In Microsoft Entra, register a single-page application for your work or
   school tenant. Add `http://localhost:5173` as a **Single-page application**
   redirect URI, or use the exact origin where you host Take Three.
2. Under Microsoft Graph delegated permissions, add `Sites.ReadWrite.All` and
   obtain any required administrator consent. This permission allows access to
   sites the signed-in user can access; it does not bypass their permissions.
3. Set `VITE_MICROSOFT_CLIENT_ID` to the application (client) ID and
   `VITE_MICROSOFT_TENANT_ID` to the directory (tenant) ID.
4. Open settings, connect SharePoint, and enter a site URL such as
   `https://company.sharepoint.com/sites/team`. Uploads go to the root of that
   site's **default** document library. The account needs write permission there.

### Google Drive

1. In Google Cloud, enable the Google Drive API and configure the OAuth consent
   screen. Add your account as a test user if the app is in testing mode.
2. Create a **Web application** OAuth client and add `http://localhost:5173`
   to its authorized JavaScript origins, or use your hosted app's exact origin.
3. Set `VITE_GOOGLE_CLIENT_ID` to that client ID. In settings, connect Google
   Drive. Uploads go to the root of the signed-in user's My Drive.

The app requests Google's `drive.file` scope, which grants access to files
created or opened by the app rather than the whole Drive. Google may require
OAuth app verification before external users can use an app in production.
The page loads Google's Identity Services script for sign-in. Provider tokens
are kept in memory for the current page session; disconnecting or reloading
removes the app's active connection. Disconnecting does not revoke prior
consent in the provider's account settings.

Select a saved recording and choose a provider under **Publish to**. Uploads
are sent directly from the browser in chunks, and the resulting link is saved
with the local recording. No sharing link or public permission is created:
the destination's existing access rules apply. If the browser closes or a
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
