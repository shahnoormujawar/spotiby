// Audio pipeline: play-dl finds candidate YouTube matches, yt-dlp fetches the audio, ffmpeg converts to MP3.
// A candidate only counts once real audio bytes arrive; otherwise the next candidate is tried.
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const play = require('play-dl');
const YTDlpWrap = require('yt-dlp-wrap').default;
const ffmpegPath = require('ffmpeg-static');
const cache = require('./cache');

const BIN = path.join(__dirname, '..', 'bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
const FIRST_BYTE_TIMEOUT = 30000;
const MAX_CANDIDATES = 4;
let ytdlp;

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
async function findCandidates(name, artists, durationMs) {
  const results = await play.search(`${artists || ''} ${name} audio`, { source: { youtube: 'video' }, limit: 8 });
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
    const run = y.exec([url, '-f', 'bestaudio/best', '--no-playlist', '--no-part', '-o', '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const proc = run.ytDlpProcess;
    let settled = false, stderr = '';
    const fail = msg => { if (settled) return; settled = true; clearTimeout(timer); try { proc.kill('SIGKILL'); } catch {} reject(new Error(msg)); };
    const timer = setTimeout(() => fail('timeout waiting for audio'), FIRST_BYTE_TIMEOUT);
    proc.stderr.on('data', d => { stderr += d; });
    proc.stdout.once('data', chunk => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      proc.stdout.pause(); proc.stdout.unshift(chunk);
      resolve(proc);
    });
    run.on('error', () => fail((stderr.match(/ERROR:[^\n]*/) || ['yt-dlp failed'])[0]));
    run.on('close', code => fail((stderr.match(/ERROR:[^\n]*/) || [`yt-dlp exited with ${code}`])[0]));
  });
}

// Returns { title, url, stream (mp3), cleanup }. Only resolves once audio is actually flowing.
async function streamMp3({ name, artists, durationMs }) {
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
      const ff = spawn(ffmpegPath, ['-loglevel', 'error', '-i', 'pipe:0', '-vn', '-codec:a', 'libmp3lame', '-b:a', '128k', '-id3v2_version', '3',
        '-metadata', `title=${name}`, '-metadata', `artist=${artists || ''}`, '-f', 'mp3', 'pipe:1']);
      proc.stdout.pipe(ff.stdin);
      ff.stdin.on('error', () => {});
      ff.stderr.on('data', d => console.error('ffmpeg:', d.toString().trim()));
      const cleanup = () => { try { proc.kill('SIGKILL'); } catch {} try { ff.kill('SIGKILL'); } catch {} };
      ff.on('error', err => { console.error('ffmpeg error:', err.message); cleanup(); });
      return { title: c.title, url: c.url, stream: ff.stdout, cleanup };
    } catch (err) {
      lastErr = err.message;
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

module.exports = { streamMp3, findMatch, findCandidates, ensureYtDlp };
