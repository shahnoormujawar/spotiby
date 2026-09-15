---
title: Spotiby
emoji: 🎧
colorFrom: green
colorTo: gray
sdk: docker
app_port: 7860
pinned: false
---

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
- **Opus audio at about 130 kbps** keeps a 200-song library around 650 MB.

## Match cache (optional MongoDB)

The server remembers which YouTube video matched each song, so repeat downloads skip the search. By default this is a JSON file in `data/`. To share the cache across deployments, set `MONGODB_URI` in `.env` to a MongoDB Atlas connection string (the free tier is plenty). The app falls back to the file if Mongo is unreachable.

## Deploy on Hugging Face Spaces (free, 2 CPUs)

1. Create a Space at https://huggingface.co/new-space: Docker SDK, Blank template, Public or Private.
2. In the Space's Settings, add secrets: `YTDLP_COOKIES` (see below), `MONGODB_URI` (optional), `MONGODB_DB` (optional).
3. Push this repo to the Space:

```bash
git remote add hf https://huggingface.co/spaces/<your-username>/spotiby
git push hf main
```

Use a Hugging Face access token with write permission as the password when prompted. The Space builds the Dockerfile and serves on port 7860. Free Spaces sleep after 48 hours without visitors and wake on the next visit.

## Deploying to a cloud host (YouTube bot check)

YouTube blocks most datacenter IPs with "Sign in to confirm you're not a bot". On your laptop this never happens; on Render, Railway, Fly, or any VPS it will. The fix is to give yt-dlp cookies from a logged-in YouTube session:

1. Use a throwaway Google account, not your main one. Google may flag the account.
2. In Chrome, log into YouTube with that account, install the "Get cookies.txt LOCALLY" extension, open youtube.com, and export cookies in Netscape format.
3. Base64-encode the file so it fits in one environment variable:

```bash
base64 -w0 cookies.txt        # Linux / Git Bash
[Convert]::ToBase64String([IO.File]::ReadAllBytes("cookies.txt"))   # PowerShell
```

4. On Render, add an environment variable `YTDLP_COOKIES` with that string and redeploy. The log will say "YouTube cookies loaded".

**JavaScript runtime.** yt-dlp needs a JS runtime to solve YouTube's stream challenge. The server passes its own Node binary to yt-dlp automatically, so nothing extra is needed. Set `YTDLP_JS_RUNTIME=deno` only if you specifically want Deno.

**Audio format.** By default the server streams YouTube's Opus audio untouched (`AUDIO_FORMAT=direct`). No ffmpeg, almost no CPU, and Android plays it natively. Set `AUDIO_FORMAT=mp3` to transcode instead; it is universal but roughly ten times the CPU, which makes a free-tier instance take a minute or more per song.

**Memory on free tiers.** Each download runs yt-dlp plus a JS runtime. `MAX_DOWNLOADS` caps how many run at once (default 2 in direct mode, 1 in mp3 mode). Phones still queue several; they wait their turn.

Cookies expire after a few weeks to months; when downloads start failing with the bot-check error again, export fresh ones. Search and download both go through yt-dlp, so the cookies cover everything.

If you'd rather not deal with cookies, run the server on a home machine and expose it with `npx cloudflared tunnel --url http://127.0.0.1:3000`. Home IPs are not blocked.

## Limits

- Spotify's public page exposes the first 50 tracks of a playlist. Albums come through in full.
- Downloading audio from YouTube is against YouTube's terms. This is a school project for personal use. Do not deploy it publicly.
- If a song matches the wrong video, the scoring is in `lib/audio.js`.

## Stack

Node + Express, `play-dl`, `yt-dlp-wrap`, `ffmpeg-static`. Vanilla JS PWA on the front end.
