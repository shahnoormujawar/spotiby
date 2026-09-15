require('dotenv').config();
const path = require('path');
const express = require('express');
const { streamMp3, ensureYtDlp, ensureDeno } = require('./lib/audio');
const { parseLink, fetchPublic, enrichArt } = require('./lib/public');
const cache = require('./lib/cache');

const PORT = process.env.PORT || 3000;
const app = express();
app.use(express.static(path.join(__dirname, 'public')));

// Read a public / link-shared playlist or album from Spotify's embed page. No Spotify account needed.
app.get('/api/public', async (req, res) => {
  const link = parseLink(req.query.url);
  if (!link) return res.status(400).json({ error: 'Paste a Spotify playlist or album link' });
  try {
    res.json(await fetchPublic(link.type, link.id));
  } catch (err) {
    console.error('public fetch failed:', err.message);
    res.status(err.message === 'not_found' ? 404 : 502).json({ error: err.message === 'not_found' ? 'Not found. Make sure the playlist is Public or shared via link.' : 'Could not read that link' });
  }
});

// Per-track cover art, fetched after the playlist is shown. ?ids=a,b,c (max 50) -> { id: url }
app.get('/api/art', async (req, res) => {
  const ids = String(req.query.ids || '').split(',').filter(x => /^[A-Za-z0-9]{10,40}$/.test(x)).slice(0, 50);
  if (!ids.length) return res.json({});
  const tracks = ids.map(id => ({ id, image: '' }));
  await enrichArt(tracks);
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.json(Object.fromEntries(tracks.filter(t => t.image).map(t => [t.id, t.image])));
});

// Proxy Spotify cover art so the browser can store it offline (CORS-safe). Only Spotify's image CDN is allowed.
app.get('/api/img', async (req, res) => {
  let u; try { u = new URL(req.query.url); } catch { return res.status(400).end(); }
  if (!/(^|\.)(scdn\.co|spotifycdn\.com)$/.test(u.hostname)) return res.status(403).end();
  try {
    const r = await fetch(u, { headers: { 'user-agent': 'Mozilla/5.0' } });
    if (!r.ok) return res.status(r.status).end();
    res.setHeader('Content-Type', r.headers.get('content-type') || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.end(Buffer.from(await r.arrayBuffer()));
  } catch { res.status(502).end(); }
});

// Find the best YouTube match for a track and stream it back as MP3.
app.get('/api/download', async (req, res) => {
  const { name, artists, duration } = req.query;
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    const { title, stream, cleanup } = await streamMp3({ name, artists, durationMs: Number(duration) || 0 });
    const safe = `${artists || ''} - ${name}`.replace(/[^\w\s\-.,()&']/g, '').trim() || 'track';
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Disposition', `attachment; filename="${safe}.mp3"`);
    res.setHeader('X-Source-Title', encodeURIComponent(title || ''));
    stream.pipe(res);
    res.on('close', cleanup);
  } catch (err) {
    console.error('download failed:', err.message);
    if (res.headersSent) return;
    if (err.message === 'blocked') return res.status(503).json({ error: 'blocked', message: 'YouTube is blocking this server. The owner needs to add YouTube cookies (see README).' });
    res.status(err.message === 'no_match' || err.message === 'no_source' ? 404 : 500).json({ error: err.message });
  }
});

app.get('/{*path}', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

ensureYtDlp().then(() => { if (process.env.YTDLP_JS_RUNTIME === 'deno') return ensureDeno(); console.log('JS runtime for yt-dlp: node'); }).catch(e => console.error(e.message));
cache.init().catch(e => console.error('cache init failed:', e.message));
app.listen(PORT, () => console.log(`Spotiby running at http://127.0.0.1:${PORT}`));
