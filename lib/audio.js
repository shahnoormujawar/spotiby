// Audio pipeline: play-dl finds candidate YouTube matches, yt-dlp fetches the audio, ffmpeg converts to MP3.
// A candidate only counts once real audio bytes arrive; otherwise the next candidate is tried.
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const play = require('play-dl');
const YTDlpWrap = require('yt-dlp-wrap').default;
const ffmpegPath = require('ffmpeg-static');
const cache = require('./cache');

const BIN = path.join(__dirname, '..', 'bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
const FIRST_BYTE_TIMEOUT = 60000;
const MAX_CANDIDATES = 4;
const BOT_CHECK = /sign in to confirm|not a bot|confirm your age|login required/i;
let ytdlp;

// Optional YouTube cookies (Netscape format, raw or base64) from YTDLP_COOKIES. Lets yt-dlp pass YouTube's
// "confirm you're not a bot" check on datacenter IPs. Written once to a temp file.
let cookiesPath;
function cookiesFile() {
  if (cookiesPath !== undefined) return cookiesPath;
  cookiesPath = null;
  let raw = process.env.YTDLP_COOKIES || '';
  if (!raw.trim()) return cookiesPath;
  if (!/^#|^\.?[a-z0-9.-]+\t/im.test(raw)) { try { raw = Buffer.from(raw.trim(), 'base64').toString('utf8'); } catch {} }
  if (!/youtube\.com/.test(raw)) { console.warn('YTDLP_COOKIES set but does not look like a Netscape cookies file; ignoring'); return cookiesPath; }
  cookiesPath = path.join(os.tmpdir(), 'spotiby-cookies.txt');
  fs.writeFileSync(cookiesPath, raw.replace(/\r\n/g, '\n'), { mode: 0o600 });
  console.log('YouTube cookies loaded');
  return cookiesPath;
}
// Deno: yt-dlp needs a JS runtime to solve YouTube's stream challenge; without one YouTube throttles or refuses audio.
// Looks for DENO_PATH, bin/deno, or deno on PATH. On Linux it will download it once if missing.
const DENO_BIN = path.join(__dirname, '..', 'bin', process.platform === 'win32' ? 'deno.exe' : 'deno');
let denoPath;
function findDeno() {
  if (denoPath !== undefined) return denoPath;
  denoPath = null;
  const candidates = [process.env.DENO_PATH, DENO_BIN].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) { denoPath = c; break; }
  if (!denoPath) { try { const r = require('child_process').spawnSync(process.platform === 'win32' ? 'where' : 'which', ['deno'], { encoding: 'utf8' }); const p = (r.stdout || '').split(/\r?\n/)[0].trim(); if (r.status === 0 && p) denoPath = p; } catch {} }
  if (denoPath) console.log('Deno found:', denoPath); else console.warn('Deno not found; YouTube downloads may be throttled or fail on cloud hosts');
  return denoPath;
}
async function ensureDeno() {
  if (findDeno()) return denoPath;
  if (process.platform !== 'linux') return null;
  try {
    console.log('Downloading Deno...');
    const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
    const r = await fetch(`https://github.com/denoland/deno/releases/latest/download/deno-${arch}-unknown-linux-gnu.zip`, { redirect: 'follow' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const zip = path.join(os.tmpdir(), 'deno.zip');
    fs.writeFileSync(zip, Buffer.from(await r.arrayBuffer()));
    fs.mkdirSync(path.dirname(DENO_BIN), { recursive: true });
    const u = require('child_process').spawnSync('unzip', ['-o', zip, '-d', path.dirname(DENO_BIN)], { encoding: 'utf8' });
    if (u.status !== 0) throw new Error('unzip failed: ' + (u.stderr || u.error));
    fs.chmodSync(DENO_BIN, 0o755);
    denoPath = undefined; findDeno();
  } catch (err) { console.warn('Deno download failed:', err.message); }
  return denoPath;
}
// yt-dlp needs a JS runtime for YouTube's stream challenge. Node is used by default: it is already installed
// and uses far less memory than Deno on small instances. Set YTDLP_JS_RUNTIME=deno to use Deno instead.
function jsRuntimeArgs() {
  if ((process.env.YTDLP_JS_RUNTIME || 'node') === 'deno') { const d = findDeno(); return d ? ['--js-runtimes', `deno:${d}`] : []; }
  return ['--js-runtimes', `node:${process.execPath}`];
}
const commonArgs = () => { const c = cookiesFile(); return [...(c ? ['--cookies', c] : []), ...jsRuntimeArgs()]; };
const NOISY = /Deprecated Feature|--no-warnings|nsig|^\s*$/i;
function logWarnings(stderr) {
  for (const line of String(stderr).split(/\r?\n/)) { if (/WARNING/.test(line) && /runtime|challenge|format|cookie|sign in|bot|missing|throttl|player/i.test(line) && !NOISY.test(line)) console.warn('yt-dlp:', line.replace(/^WARNING:\s*/, '').slice(0, 300)); }
}

// Server-side limit on simultaneous downloads. Each one runs yt-dlp + a JS runtime + ffmpeg, so on a 512 MB
// instance more than one at a time gets the process OOM-killed. Extra requests wait their turn.
// AUDIO_FORMAT=direct (default): stream YouTube's Opus/WebM audio as-is. No ffmpeg, almost no CPU. Android plays it natively.
// AUDIO_FORMAT=mp3: transcode with ffmpeg. Universal, but ~10x the CPU; too slow on tiny cloud instances.
const DIRECT = (process.env.AUDIO_FORMAT || 'direct') !== 'mp3';
const MAX_DOWNLOADS = Math.max(1, Number(process.env.MAX_DOWNLOADS) || (DIRECT ? 2 : 1));
let activeDownloads = 0; const waiters = [];
function acquire() { if (activeDownloads < MAX_DOWNLOADS) { activeDownloads++; return Promise.resolve(); } return new Promise(r => waiters.push(r)).then(() => { activeDownloads++; }); }
function release() { activeDownloads--; const w = waiters.shift(); if (w) w(); }
const isBotCheck = msg => BOT_CHECK.test(msg || '');

async function ensureYtDlp() {
  if (ytdlp) return ytdlp;
  if (!fs.existsSync(BIN)) {
    console.log('Downloading yt-dlp binary...');
    fs.mkdirSync(path.dirname(BIN), { recursive: true });
    // Direct release URL: avoids the GitHub API, which rate-limits shared cloud IPs.
    const asset = process.platform === 'win32' ? 'yt-dlp.exe' : process.platform === 'darwin' ? 'yt-dlp_macos' : 'yt-dlp';
    const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}`;
    try {
      const r = await fetch(url, { redirect: 'follow' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      fs.writeFileSync(BIN, Buffer.from(await r.arrayBuffer()));
    } catch (err) { try { fs.unlinkSync(BIN); } catch {} throw new Error('yt-dlp download failed: ' + (err && err.message ? err.message : String(err))); }
    if (process.platform !== 'win32') fs.chmodSync(BIN, 0o755);
    console.log('yt-dlp ready');
  }
  ytdlp = new YTDlpWrap(BIN);
  return ytdlp;
}

// Ranked candidates: closest duration wins, "official audio" titles get a bonus, live/cover/remix get a penalty.
async function searchYtDlp(query) {
  const y = await ensureYtDlp();
  const out = await y.execPromise([`ytsearch8:${query}`, '--flat-playlist', '--dump-single-json', ...commonArgs()]);
  const j = JSON.parse(out);
  return (j.entries || []).filter(e => e && e.id).map(e => ({ url: `https://www.youtube.com/watch?v=${e.id}`, title: e.title || '', durationInSec: Number(e.duration) || 0 }));
}
async function searchPlayDl(query) {
  const r = await play.search(query, { source: { youtube: 'video' }, limit: 8 });
  return r.map(v => ({ url: v.url, title: v.title, durationInSec: v.durationInSec }));
}
async function findCandidates(name, artists, durationMs) {
  const query = `${artists || ''} ${name} audio`;
  let results = [];
  try { results = await searchYtDlp(query); }
  catch (err) {
    if (isBotCheck(err.message || String(err))) throw new Error('blocked');
    console.warn('yt-dlp search failed, using play-dl:', (err.message || String(err)).split('\n')[0]);
    results = await searchPlayDl(query);
  }
  const lname = name.toLowerCase();
  return results.map(v => {
    let score = durationMs ? Math.abs(v.durationInSec * 1000 - durationMs) / 1000 : 0;
    const t = (v.title || '').toLowerCase();
    if (/official audio|lyric|audio/.test(t)) score -= 5;
    if (/live|cover|remix|karaoke|instrumental|reaction|slowed|sped up|8d/.test(t) && !/live|cover|remix|karaoke|instrumental/.test(lname)) score += 60;
    return { url: v.url, title: v.title, score };
  }).sort((a, b) => a.score - b.score).slice(0, MAX_CANDIDATES);
}
async function findMatch(name, artists, durationMs) { return (await findCandidates(name, artists, durationMs))[0] || null; }

// Start yt-dlp for a URL and resolve with the process once the first audio chunk has arrived.
function startSource(y, url) {
  return new Promise((resolve, reject) => {
    const fmt = DIRECT ? '251/bestaudio[ext=webm]/bestaudio[acodec^=opus]/bestaudio/best' : 'bestaudio/best';
    const infoFile = path.join(os.tmpdir(), `spotiby-fmt-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
    const run = y.exec([url, '-f', fmt, '--no-playlist', '--no-part', '-o', '-', '--print-to-file', '%(format_id)s|%(acodec)s|%(vcodec)s|%(ext)s', infoFile, ...commonArgs()], { stdio: ['ignore', 'pipe', 'pipe'] });
    const proc = run.ytDlpProcess;
    let settled = false, stderr = '';
    const fail = msg => { if (settled) return; settled = true; clearTimeout(timer); try { proc.kill('SIGKILL'); } catch {} reject(new Error(msg)); };
    const timer = setTimeout(() => fail('timeout waiting for audio'), FIRST_BYTE_TIMEOUT);
    proc.stderr.on('data', d => { stderr += d; });
    proc.stdout.once('data', chunk => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      proc.stdout.pause(); proc.stdout.unshift(chunk);
      logWarnings(stderr);
      let picked = null;
      try { const [format_id, acodec, vcodec, ext] = fs.readFileSync(infoFile, 'utf8').trim().split('|'); picked = { format_id, acodec, vcodec, ext }; } catch {}
      try { fs.unlinkSync(infoFile); } catch {}
      proc.picked = picked;
      resolve(proc);
    });
    run.on('error', () => { logWarnings(stderr); fail((stderr.match(/ERROR:[^\n]*/) || ['yt-dlp failed'])[0]); });
    run.on('close', code => { logWarnings(stderr); try { fs.unlinkSync(infoFile); } catch {} fail((stderr.match(/ERROR:[^\n]*/) || [`yt-dlp exited with ${code}`])[0]); });
  });
}

// Returns { title, url, stream (mp3), cleanup }. Only resolves once audio is actually flowing.
async function streamMp3(track) {
  await acquire();
  let released = false; const done = () => { if (!released) { released = true; release(); } };
  try { const r = await streamMp3Inner(track); const c = r.cleanup; r.cleanup = () => { c(); done(); }; r.stream.on('close', done); r.stream.on('end', done); return r; }
  catch (e) { done(); throw e; }
}
async function streamMp3Inner({ name, artists, durationMs }) {
  const track = { name, artists, durationMs };
  const y = await ensureYtDlp();
  const cached = await cache.get(track).catch(() => null);
  let candidates = cached ? [{ ...cached, cached: true }] : [];
  if (!candidates.length) candidates = await findCandidates(name, artists, durationMs);
  if (!candidates.length) throw new Error('no_match');

  let lastErr = 'no_match';
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    try {
      const proc = await startSource(y, c.url);
      if (!c.cached) cache.set(track, c).catch(() => {});
      if (DIRECT) {
        const p = proc.picked || {};
        const audioOnly = !p.vcodec || p.vcodec === 'none';
        console.log(`source: ${p.format_id || '?'} ${p.acodec || ''}${audioOnly ? '' : ' (muxed ' + p.vcodec + ', extracting audio)'}`);
        if (audioOnly) {
          const cleanup = () => { try { proc.kill('SIGKILL'); } catch {} };
          proc.stdout.resume();
          const opus = /opus/i.test(p.acodec || '') || p.ext === 'webm';
          return { title: c.title, url: c.url, stream: proc.stdout, cleanup, mime: opus ? 'audio/webm' : 'audio/mp4', ext: opus ? 'webm' : 'm4a' };
        }
        // Muxed stream: strip the video without re-encoding. AAC -> ADTS (audio/aac), anything else -> Opus in WebM.
        const aac = /aac|mp4a/i.test(p.acodec || '');
        const ff = spawn(ffmpegPath, ['-loglevel', 'error', '-i', 'pipe:0', '-vn', '-threads', '1', ...(aac ? ['-c:a', 'copy', '-f', 'adts'] : ['-c:a', 'libopus', '-b:a', '128k', '-f', 'webm']), 'pipe:1']);
        proc.stdout.pipe(ff.stdin); ff.stdin.on('error', () => {});
        ff.stderr.on('data', d => console.error('ffmpeg:', d.toString().trim()));
        const cleanup = () => { try { proc.kill('SIGKILL'); } catch {} try { ff.kill('SIGKILL'); } catch {} };
        ff.on('error', err => { console.error('ffmpeg error:', err.message); cleanup(); });
        return { title: c.title, url: c.url, stream: ff.stdout, cleanup, mime: aac ? 'audio/aac' : 'audio/webm', ext: aac ? 'aac' : 'webm' };
      }
      const ff = spawn(ffmpegPath, ['-loglevel', 'error', '-i', 'pipe:0', '-vn', '-threads', '1', '-codec:a', 'libmp3lame', '-b:a', '128k', '-id3v2_version', '3',
        '-metadata', `title=${name}`, '-metadata', `artist=${artists || ''}`, '-f', 'mp3', 'pipe:1']);
      proc.stdout.pipe(ff.stdin);
      ff.stdin.on('error', () => {});
      ff.stderr.on('data', d => console.error('ffmpeg:', d.toString().trim()));
      const cleanup = () => { try { proc.kill('SIGKILL'); } catch {} try { ff.kill('SIGKILL'); } catch {} };
      ff.on('error', err => { console.error('ffmpeg error:', err.message); cleanup(); });
      return { title: c.title, url: c.url, stream: ff.stdout, cleanup, mime: 'audio/mpeg', ext: 'mp3' };
    } catch (err) {
      lastErr = err.message;
      if (isBotCheck(err.message)) {
        console.error(`YouTube is blocking this server's IP (bot check). ${cookiesFile() ? 'Cookies are set but were rejected; export fresh ones.' : 'Set YTDLP_COOKIES to fix. See README.'}`);
        throw new Error('blocked');
      }
      console.warn(`source failed (${c.cached ? 'cached' : 'candidate ' + (i + 1)}): ${c.url} -> ${err.message}`);
      if (c.cached) {
        await cache.del(track).catch(() => {});
        const fresh = await findCandidates(name, artists, durationMs);
        candidates = candidates.concat(fresh.filter(f => f.url !== c.url));
      }
    }
  }
  throw new Error(lastErr.includes('ERROR') ? 'no_source' : lastErr);
}

module.exports = { streamMp3, findMatch, findCandidates, ensureYtDlp, ensureDeno };
