# SimpleNotes

Fast notes with Google sign-in, Firestore sync, offline drafts, and optional Gemini voice transcription.

## Sync

Sign into the same Google account on each device. Notes are saved in IndexedDB first, then written to `users/{uid}/notes/{noteId}` in Firestore. A Firestore listener updates other signed-in devices. Notes made offline sync when the device reconnects.

This copy uses the `paper-rockets-test` Firebase project and its `SimpleNotes GitHub Pages` Web app. Google sign-in is enabled, and `paper-rockets.github.io` is an authorized Authentication domain. Create a Firestore database and deploy `firestore.rules` before using sync. The rules allow each signed-in user to read and write only their own notes.

## Voice notes

Enter a Gemini API key in Settings on each device. The key is stored in that browser's local storage and is sent directly to Google's Gemini API for transcription. It is not added to source code or synced with notes. Recordings stay in IndexedDB until transcription succeeds; only text is synced to Firestore.

## Status

The source has passed JavaScript syntax, JSON, and Git whitespace checks. Browser sign-in, Gemini API, and two-device Firestore sync still require live testing before release.
