# Spotiby

Paste a Spotify playlist link, save every song to your phone, and play them offline. No Spotify login, no API keys.

Spotify only shares track metadata, so the audio comes from a matched YouTube upload. `play-dl` finds the match, `yt-dlp` fetches the audio, and `ffmpeg` converts it to a tagged MP3.

## Run it

```bash
npm install
npm start
```

Open http://127.0.0.1:3000. The `yt-dlp` binary is downloaded into `bin/` on first start.

## Add a playlist

1. In Spotify, open your playlist and tap **⋯**.
2. Choose **Make public**. Private playlists will not load.
3. Tap **Share → Copy link** and paste it into the app.

Album links work the same way.

## What it does

- **Playlists** tab: every playlist you've added, with cover art.
- **Download all** on a playlist saves each song as an MP3 inside the browser (IndexedDB). A progress bar shows how far along it is.
- **Saved** tab: everything stored on this device. Tap a song to play, tap the disk icon to export the MP3 file to your phone, or trash to remove it.
- **Player** bar with seek, previous and next. Lock-screen controls work through the Media Session API.
- Installs as a home-screen app and works offline once songs are downloaded.

## On a phone

Run the server on your laptop, then expose it so your phone can reach it:

```bash
npx ngrok http 3000
```

Open the ngrok link on your phone and choose "Add to Home Screen".

## Built for real use

- **Offline first.** Songs, cover art, and playlist track lists are stored on the device in IndexedDB. The app shell and font are cached by a service worker, so everything except adding new playlists works with no connection.
- **Download queue.** "Download all" queues songs in IndexedDB and downloads two at a time with three retries and backoff. Close the app mid-way and it resumes on next launch. A banner shows progress on every screen, with cancel and retry.
- **Scales to hundreds of songs.** Track metadata and audio live in separate stores, so listing the library never touches the audio. Audio is read only when a song plays.
- **Background playback.** Uses the Media Session API for the Android media notification and lock screen, including a scrubber. The next song is preloaded so transitions are gapless when the screen is off.
- **Protected storage.** Asks Chrome for persistent storage on the first download so songs are not evicted. The Saved tab shows space used.
- **128 kbps MP3** keeps a 200-song library around 650 MB.

## Match cache (optional MongoDB)

The server remembers which YouTube video matched each song, so repeat downloads skip the search. By default this is a JSON file in `data/`. To share the cache across deployments, set `MONGODB_URI` in `.env` to a MongoDB Atlas connection string (the free tier is plenty). The app falls back to the file if Mongo is unreachable.

## Limits

- Spotify's public page exposes the first 50 tracks of a playlist. Albums come through in full.
- Downloading audio from YouTube is against YouTube's terms. This is a school project for personal use. Do not deploy it publicly.
- If a song matches the wrong video, the scoring is in `lib/audio.js`.

## Stack

Node + Express, `play-dl`, `yt-dlp-wrap`, `ffmpeg-static`. Vanilla JS PWA on the front end.
