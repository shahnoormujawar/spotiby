// No-credentials fallback: Spotify's public embed page ships playlist/album data in a __NEXT_DATA__ blob.
// Works for any public playlist or album. Limits: ~50 tracks per playlist, no Liked Songs, no private playlists.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';

function parseLink(input) {
  const s = String(input || '').trim();
  let m = s.match(/spotify:(playlist|album):([A-Za-z0-9]+)/);
  if (!m) m = s.match(/open\.spotify\.com\/(?:intl-[a-z]+\/)?(?:embed\/)?(playlist|album)\/([A-Za-z0-9]+)/);
  if (!m) return null;
  return { type: m[1], id: m[2] };
}

async function fetchPublic(type, id) {
  const r = await fetch(`https://open.spotify.com/embed/${type}/${id}`, { headers: { 'user-agent': UA, 'accept-language': 'en' } });
  if (!r.ok) throw new Error(`spotify_${r.status}`);
  const html = await r.text();
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('no_data');
  const e = JSON.parse(m[1]).props.pageProps.state.data.entity;
  if (!e || !e.trackList) throw new Error('not_found');
  const image = e.coverArt && e.coverArt.sources && e.coverArt.sources[0] ? e.coverArt.sources[0].url : '';
  const owner = e.subtitle || (e.authors && e.authors.length ? e.authors.map(a => a.name).join(', ') : (type === 'album' ? 'Album' : 'Playlist'));
  const tracks = e.trackList.filter(t => t.uri && t.title).map(t => ({
    id: t.uri.split(':').pop(),
    name: t.title,
    artists: t.subtitle || '',
    album: type === 'album' ? e.name : '',
    image,
    duration_ms: t.duration || 0,
  }));
  return { playlist: { id: `pub:${type}:${id}`, name: e.name, owner, total: tracks.length, image, public: true, type }, tracks };
}

// Per-track cover art via Spotify's public oEmbed endpoint (the embed page only has one image per playlist).
const artCache = new Map();
async function trackArt(id) {
  if (artCache.has(id)) return artCache.get(id);
  try {
    const r = await fetch(`https://open.spotify.com/oembed?url=spotify:track:${id}`, { headers: { 'user-agent': UA } });
    if (!r.ok) throw new Error(r.status);
    const url = (await r.json()).thumbnail_url || '';
    artCache.set(id, url);
    return url;
  } catch { return ''; }
}
async function enrichArt(tracks, concurrency = 12) {
  const queue = tracks.slice();
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (queue.length) { const t = queue.shift(); const art = await trackArt(t.id); if (art) t.image = art; }
  }));
  return tracks;
}

module.exports = { parseLink, fetchPublic, enrichArt };
