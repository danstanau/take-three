# Take Three

Take Three is a browser-based screen recording app for recording, reviewing, saving, and publishing short videos to SharePoint or Google Drive.

## Run locally

```bash
npm install
npm run dev
```

Open the local URL shown by Vite. Screen recording requires a supported Chromium, Edge, or Firefox browser and a secure context (`localhost` is treated as secure).

## Features

- Screen capture with optional microphone audio
- Three-second countdown with an audible cue
- Recording timer and floating Picture-in-Picture controls in supported browsers
- Local IndexedDB recording library
- First-frame thumbnail generation and custom thumbnail uploads
- Download and delete actions
- SharePoint and Google Drive connection controls
- Publish-ready metadata for future OAuth uploads

## Storage integration status

This prototype persists videos and thumbnails in the browser. SharePoint and Google Drive are represented through a provider abstraction and connection settings; live OAuth and resumable uploads require tenant-specific credentials and a backend:

- Microsoft Graph upload sessions for SharePoint
- Google OAuth 2.0 and Drive API multipart/resumable uploads

## Rust migration

The recommended migration sequence is to keep the React/TypeScript frontend and move server-side services to Rust after the browser product stabilizes:

1. Rust API (`axum`) for authentication and recording metadata
2. PostgreSQL or SQLite for metadata
3. Object storage for source and rendered videos
4. FFmpeg worker for MP4 conversion and trimming
5. Provider adapters for Microsoft Graph and Google Drive
6. Optional Tauri desktop shell for native macOS capture and Picture-in-Picture
