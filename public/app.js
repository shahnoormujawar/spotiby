/* Spotiby front-end
   - IndexedDB v2: meta (track info + cover blob), audio (mp3 blob), playlists (track lists for offline), queue (pending downloads)
   - Persisted download queue with retries, resumes on launch
   - Player preloads the next track, reports position to Media Session (lock-screen scrubber)
*/
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
const fmtTime = ms => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const fmtMB = b => b > 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GB` : `${Math.round(b / 1048576)} MB`;
const escape = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const buzz = ms => { try { navigator.vibrate && navigator.vibrate(ms); } catch {} };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const ICON = {
  dl: '<svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M5 20h14v-2H5zm7-2 5.5-5.5-1.4-1.4L13 14.2V4h-2v10.2L7.9 11.1l-1.4 1.4z"/></svg>',
  ok: '<svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm-2 15-5-5 1.4-1.4L10 14.2l7.6-7.6L19 8z"/></svg>',
  spin: '<svg viewBox="0 0 24 24" width="22" height="22"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="3" fill="none" stroke-dasharray="40 20" stroke-linecap="round"/></svg>',
  wait: '<svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16zm.5-13H11v6l5.2 3.1.8-1.2-4.5-2.7z"/></svg>',
  err: '<svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 15h-2v-2h2zm0-4h-2V7h2z"/></svg>',
  trash: '<svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6zM19 4h-3.5l-1-1h-5l-1 1H5v2h14z"/></svg>',
  save: '<svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M19 12v7H5v-7H3v7a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7zm-6 .7 2.6-2.6L17 11.5l-5 5-5-5 1.4-1.4 2.6 2.6V3h2z"/></svg>',
  play: '<path fill="currentColor" d="M8 5v14l11-7z"/>',
  pause: '<path fill="currentColor" d="M6 5h4v14H6zm8 0h4v14h-4z"/>',
  eq: '<span class="eq"><i></i><i></i><i></i></span>',
};

// ================= IndexedDB =================
const db = {
  _p: null,
  open() {
    if (this._p) return this._p;
    this._p = new Promise((res, rej) => {
      const r = indexedDB.open('spotiby', 2);
      r.onupgradeneeded = e => {
        const d = r.result, tx = r.transaction;
        if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'id' }).createIndex('savedAt', 'savedAt');
        if (!d.objectStoreNames.contains('audio')) d.createObjectStore('audio', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('playlists')) d.createObjectStore('playlists', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('queue')) d.createObjectStore('queue', { keyPath: 'id' }).createIndex('status', 'status');
        // v1 -> v2: move { ...track, blob } rows into meta + audio
        if (d.objectStoreNames.contains('tracks')) {
          const old = tx.objectStore('tracks'), meta = tx.objectStore('meta'), audio = tx.objectStore('audio');
          old.openCursor().onsuccess = ev => {
            const c = ev.target.result;
            if (!c) { d.deleteObjectStore('tracks'); return; }
            const { blob, ...m } = c.value; m.size = blob ? blob.size : 0;
            meta.put(m); if (blob) audio.put({ id: m.id, blob });
            c.continue();
          };
        }
      };
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    return this._p;
  },
  async tx(stores, mode, fn) {
    const d = await this.open();
    return new Promise((res, rej) => {
      const t = d.transaction(stores, mode);
      const s = Array.isArray(stores) ? stores.map(n => t.objectStore(n)) : t.objectStore(stores);
      let out; try { out = fn(s); } catch (e) { rej(e); return; }
      t.oncomplete = () => res(out && out.result !== undefined ? out.result : out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
    });
  },
  // meta
  metaAll() { return this.tx('meta', 'readonly', s => s.getAll()); },
  metaKeys() { return this.tx('meta', 'readonly', s => s.getAllKeys()); },
  metaGet(id) { return this.tx('meta', 'readonly', s => s.get(id)); },
  // audio
  audioGet(id) { return this.tx('audio', 'readonly', s => s.get(id)); },
  saveTrack(meta, blob) { return this.tx(['meta', 'audio'], 'readwrite', ([m, a]) => { m.put(meta); a.put({ id: meta.id, blob }); }); },
  deleteTrack(id) { return this.tx(['meta', 'audio'], 'readwrite', ([m, a]) => { m.delete(id); a.delete(id); }); },
  // playlists
  plGet(id) { return this.tx('playlists', 'readonly', s => s.get(id)); },
  plPut(p) { return this.tx('playlists', 'readwrite', s => s.put(p)); },
  plDel(id) { return this.tx('playlists', 'readwrite', s => s.delete(id)); },
  // queue
  qAll() { return this.tx('queue', 'readonly', s => s.getAll()); },
  qPut(item) { return this.tx('queue', 'readwrite', s => s.put(item)); },
  qPutMany(items) { return this.tx('queue', 'readwrite', s => { items.forEach(i => s.put(i)); }); },
  qDel(id) { return this.tx('queue', 'readwrite', s => s.delete(id)); },
  qClear() { return this.tx('queue', 'readwrite', s => s.clear()); },
};

// ================= State =================
const PUB_KEY = 'spotiby.public';
const loadPublic = () => { try { return JSON.parse(localStorage.getItem(PUB_KEY) || '[]'); } catch { return []; } };
const savePublic = list => { try { localStorage.setItem(PUB_KEY, JSON.stringify(list)); } catch {} };
const state = {
  publicLists: loadPublic(), publicTracks: {}, current: null, tracks: [], saved: new Set(), metaById: new Map(),
  queue: [], qIndex: -1, tab: 'playlists', shuffle: false, repeat: false, savedItems: [], search: '',
  cur: { id: null, url: null, streaming: false }, pre: { id: null, url: null },
  dl: { running: false, active: new Set(), total: 0, done: 0, failed: 0, cancelled: false },
  online: navigator.onLine !== false,
};
const audio = $('#audio');
const urlCache = new Map(); // id -> object URL for cover blobs
function coverUrl(t) {
  const m = state.metaById.get(t.id);
  if (m && m.imageBlob) { if (!urlCache.has(t.id)) urlCache.set(t.id, URL.createObjectURL(m.imageBlob)); return urlCache.get(t.id); }
  return t.image || '';
}
function plCoverUrl(p) {
  const key = 'pl:' + p.id;
  if (p.coverBlob) { if (!urlCache.has(key)) urlCache.set(key, URL.createObjectURL(p.coverBlob)); return urlCache.get(key); }
  return p.image || '';
}

function toast(msg, ms = 2200) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('show'), ms); }
function updateBadge() { const b = $('#saved-badge'); b.textContent = state.saved.size; b.classList.toggle('hidden', !state.saved.size); }
async function refreshMeta() { const all = await db.metaAll(); state.metaById = new Map(all.map(m => [m.id, m])); state.saved = new Set(state.metaById.keys()); updateBadge(); }

// ================= Views =================
function showWelcome() { $('#view-login').classList.remove('hidden'); $('#view-main').classList.add('hidden'); }
function showMain() { $('#view-login').classList.add('hidden'); $('#view-main').classList.remove('hidden'); renderPlaylists(); updateBadge(); }
function showPage(name) {
  ['playlists', 'tracks', 'downloads'].forEach(p => $(`#page-${p}`).classList.toggle('hidden', p !== name));
  $('#back-btn').classList.toggle('hidden', name !== 'tracks');
  $('#title').textContent = name === 'playlists' ? 'Playlists' : name === 'downloads' ? 'Saved' : (state.current ? state.current.name : '');
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === (name === 'tracks' ? 'playlists' : name)));
  window.scrollTo(0, 0);
}
function setOnline(on) { state.online = on; document.body.classList.toggle('offline', !on); $('#offline-chip').classList.toggle('hidden', on); if (on) runQueue(); }
window.addEventListener('online', () => { setOnline(true); toast('Back online'); });
window.addEventListener('offline', () => { setOnline(false); toast('You are offline. Saved songs still play.'); });

async function init() {
  await refreshMeta();
  // hydrate playlists with stored cover blobs
  for (const p of state.publicLists) { const st = await db.plGet(p.id).catch(() => null); if (st) { p.coverBlob = st.coverBlob; state.publicTracks[p.id] = st.tracks; } }
  if (state.publicLists.length || state.saved.size) showMain(); else showWelcome();
  setOnline(navigator.onLine !== false);
  // resume interrupted downloads
  const q = await db.qAll();
  if (q.length) { state.dl.total = q.length; state.dl.done = 0; state.dl.failed = q.filter(i => i.status === 'failed').length; renderBanner(); if (q.some(i => i.status !== 'failed')) runQueue(); }
}

// ================= Playlists =================
async function fetchCover(url) {
  if (!url) return null;
  try { const r = await fetch(`/api/img?url=${encodeURIComponent(url)}`); if (!r.ok) return null; return await r.blob(); } catch { return null; }
}
async function addPublic(url, input, btn) {
  if (!url) return;
  if (!state.online) return toast('You are offline');
  const old = btn.innerHTML; btn.disabled = true; btn.innerHTML = ICON.spin.replace(/22/g, '18');
  try {
    const r = await fetch(`/api/public?url=${encodeURIComponent(url)}`);
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Could not open link');
    const p = data.playlist;
    state.publicTracks[p.id] = data.tracks;
    state.publicLists = [p, ...state.publicLists.filter(x => x.id !== p.id)];
    savePublic(state.publicLists.map(({ coverBlob, ...rest }) => rest));
    input.value = ''; input.blur();
    if ($('#view-main').classList.contains('hidden')) showMain(); else renderPlaylists();
    openPlaylist(p); buzz(15);
    fetchCover(p.image).then(async blob => { p.coverBlob = blob; await db.plPut({ id: p.id, tracks: data.tracks, coverBlob: blob, savedAt: Date.now() }); });
  } catch (e) { toast(e.message); buzz([30, 40, 30]); }
  btn.disabled = false; btn.innerHTML = old;
}
function savedCountFor(p) { const list = state.publicTracks[p.id]; return list ? list.filter(t => state.saved.has(t.id)).length : null; }
function renderPlaylists() {
  const g = $('#playlist-grid'); g.innerHTML = '';
  for (const p of state.publicLists) {
    const c = el('div', 'card'); const n = savedCountFor(p);
    c.innerHTML = `<img class="card-cover" src="${plCoverUrl(p)}" alt="" loading="lazy"><div class="card-name">${escape(p.name)}</div><div class="card-sub">${p.total} songs · ${escape(p.owner)}</div>`;
    if (n) c.append(el('div', 'card-badge', `<svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>${n === p.total ? 'Saved' : `${n}/${p.total}`}`));
    c.onclick = () => openPlaylist(p);
    const x = el('button', 'card-remove', '×'); x.title = 'Remove';
    x.onclick = e => { e.stopPropagation(); state.publicLists = state.publicLists.filter(q => q.id !== p.id); savePublic(state.publicLists.map(({ coverBlob, ...r }) => r)); db.plDel(p.id); renderPlaylists(); toast('Removed. Saved songs are kept.'); };
    c.append(x); g.append(c);
  }
  if (!state.publicLists.length) g.append(el('div', 'empty', '<div class="empty-art"><svg viewBox="0 0 24 24" width="44" height="44"><path fill="currentColor" d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3z"/></svg></div><h3>No playlists yet</h3><p>Paste a public playlist or album link above.</p>'));
}
async function openPlaylist(p) {
  state.current = p; state.tracks = [];
  $('#pl-name').textContent = p.name; $('#pl-sub').textContent = `${p.total} songs · ${p.owner}`;
  const cov = plCoverUrl(p); $('#pl-cover').src = cov; $('#pl-backdrop-img').src = cov;
  $('#track-list').innerHTML = '<li class="skel" style="height:66px;margin-bottom:8px"></li>'.repeat(8);
  showPage('tracks');
  try {
    if (!state.publicTracks[p.id]) {
      const stored = await db.plGet(p.id).catch(() => null);
      if (stored) state.publicTracks[p.id] = stored.tracks;
      else {
        if (!state.online) throw new Error('offline');
        const r = await fetch(`/api/public?url=spotify:${p.type}:${p.id.split(':').pop()}`);
        if (!r.ok) throw new Error();
        const data = await r.json(); state.publicTracks[p.id] = data.tracks;
        db.plPut({ id: p.id, tracks: data.tracks, coverBlob: p.coverBlob || null, savedAt: Date.now() });
      }
    }
    state.tracks = state.publicTracks[p.id];
    renderTracks(); updateDownloadAllLabel();
    fillArt(p, state.tracks);
  } catch (e) { toast(e.message === 'offline' ? 'Offline. Open this playlist once while online.' : 'Could not load tracks'); $('#track-list').innerHTML = ''; }
}

// Fill per-track covers after the list is visible. Spotify's embed only gives one image per playlist.
async function fillArt(p, tracks) {
  if (!state.online || p.type !== 'playlist') return;
  const need = tracks.filter(t => !t.artDone);
  if (!need.length) return;
  for (let i = 0; i < need.length; i += 50) {
    const batch = need.slice(i, i + 50);
    try {
      const r = await fetch(`/api/art?ids=${batch.map(t => t.id).join(',')}`);
      if (!r.ok) return;
      const map = await r.json();
      batch.forEach(t => { t.artDone = true; if (map[t.id]) { t.image = map[t.id]; const img = $(`#track-list li[data-id="${t.id}"] .t-art`); if (img && state.current && state.current.id === p.id && !state.metaById.has(t.id)) img.src = t.image; } });
    } catch { return; }
  }
  db.plPut({ id: p.id, tracks, coverBlob: p.coverBlob || null, savedAt: Date.now() }).catch(() => {});
}

// ================= Track rows =================
function isCurrent(t) { return state.cur.id === t.id; }
function rowStatus(t) {
  if (state.saved.has(t.id)) return 'done';
  if (state.dl.active.has(t.id)) return 'busy';
  const q = state.dl.items && state.dl.items.get(t.id);
  if (q) return q.status === 'failed' ? 'err' : 'wait';
  return '';
}
const STATUS_ICON = { done: ICON.ok, busy: ICON.spin, wait: ICON.wait, err: ICON.err, '': ICON.dl };
function trackRow(t, i, { onAction, actionIcon, actionCls = '', extra } = {}) {
  const li = el('li', 'track'); li.dataset.id = t.id; li.style.animationDelay = `${Math.min(i, 12) * 25}ms`;
  li.innerHTML = `<div class="t-num">${isCurrent(t) ? ICON.eq : i + 1}</div><img class="t-art" src="${coverUrl(t)}" alt="" loading="lazy"><button class="t-body"><div class="t-name">${escape(t.name)}</div><div class="t-sub">${escape(t.artists)}</div></button><span class="t-dur">${fmtTime(t.duration_ms)}</span>`;
  $('.t-body', li).onclick = () => playTrack(t);
  if (extra) li.append(extra);
  const b = el('button', `t-action ${actionCls}`, actionIcon); b.onclick = () => onAction(t, b); li.append(b);
  if (isCurrent(t)) li.classList.add('playing');
  return li;
}
function renderTracks() {
  const ul = $('#track-list'); ul.innerHTML = '';
  state.tracks.forEach((t, i) => { const s = rowStatus(t); ul.append(trackRow(t, i, { onAction: downloadOne, actionIcon: STATUS_ICON[s], actionCls: s })); });
}
function setRowStatus(id, s) { const b = $(`#track-list li[data-id="${id}"] .t-action`); if (b) { b.className = `t-action ${s}`; b.innerHTML = STATUS_ICON[s]; } }
function updateDownloadAllLabel() {
  const left = state.tracks.filter(t => !state.saved.has(t.id) && !(state.dl.items && state.dl.items.has(t.id))).length;
  const lbl = $('#download-all-label');
  if (!state.tracks.length) lbl.textContent = 'Download all';
  else if (left === 0) lbl.textContent = state.tracks.every(t => state.saved.has(t.id)) ? 'All saved' : 'Queued';
  else lbl.textContent = left === state.tracks.length ? 'Download all' : `Download ${left} more`;
  $('#download-all').disabled = !left;
}

// ================= Saved tab =================
async function renderDownloads() {
  state.savedItems = Array.from(state.metaById.values()).sort((a, b) => b.savedAt - a.savedAt);
  const q = state.search.trim().toLowerCase();
  const items = q ? state.savedItems.filter(t => (t.name + ' ' + t.artists + ' ' + (t.album || '')).toLowerCase().includes(q)) : state.savedItems;
  const ul = $('#download-list'); ul.innerHTML = '';
  const any = state.savedItems.length > 0;
  $('#dl-empty').classList.toggle('hidden', any); $('.dl-toolbar').classList.toggle('hidden', !any); $('.searchbox').classList.toggle('hidden', !any);
  const bytes = state.savedItems.reduce((n, t) => n + (t.size || 0), 0);
  $('#dl-summary').textContent = q ? `${items.length} of ${state.savedItems.length} songs` : `${state.savedItems.length} songs · ${fmtMB(bytes)}`;
  items.forEach((t, i) => {
    const save = el('button', 't-action', ICON.save); save.title = 'Save MP3 to phone';
    save.onclick = async () => { const a = await db.audioGet(t.id); if (!a) return; const link = document.createElement('a'); link.href = URL.createObjectURL(a.blob); link.download = `${t.artists} - ${t.name}.mp3`; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 5000); toast('Exporting MP3'); };
    ul.append(trackRow(t, i, { extra: save, actionIcon: ICON.trash, onAction: async (tr, b) => {
      await db.deleteTrack(tr.id); state.metaById.delete(tr.id); state.saved.delete(tr.id); updateBadge();
      if (urlCache.has(tr.id)) { URL.revokeObjectURL(urlCache.get(tr.id)); urlCache.delete(tr.id); }
      const li = b.closest('li'); li.style.transition = 'opacity .2s, transform .2s'; li.style.opacity = '0'; li.style.transform = 'translateX(30px)';
      setTimeout(() => { renderDownloads(); if (state.current) { renderTracks(); updateDownloadAllLabel(); } }, 200);
      toast('Removed');
    } }));
  });
  if (q && !items.length) ul.append(el('div', 'empty', `<p>No matches for “${escape(state.search)}”</p>`));
  renderStorage(any);
}
async function renderStorage(show) {
  const box = $('#storage'); if (!show || !navigator.storage || !navigator.storage.estimate) return box.classList.add('hidden');
  try {
    const { usage, quota } = await navigator.storage.estimate();
    box.classList.remove('hidden');
    $('#storage-bar').style.width = `${Math.min(100, (usage / quota) * 100).toFixed(1)}%`;
    const persisted = navigator.storage.persisted ? await navigator.storage.persisted() : false;
    $('#storage-text').innerHTML = `<span>${fmtMB(usage)} used of ${fmtMB(quota)} available</span><span>${persisted ? 'Protected storage' : ''}</span>`;
  } catch { box.classList.add('hidden'); }
}

// ================= Download queue =================
const MAX_ATTEMPTS = 3, BACKOFF = [2000, 6000, 15000], CONCURRENCY = 2;
async function ensurePersist() { try { if (navigator.storage && navigator.storage.persist && !(await navigator.storage.persisted())) await navigator.storage.persist(); } catch {} }

async function fetchTrack(t) {
  const q = new URLSearchParams({ name: t.name, artists: t.artists, duration: t.duration_ms });
  const r = await fetch(`/api/download?${q}`);
  if (!r.ok) throw new Error(r.status === 404 ? 'no_match' : r.status === 503 ? 'blocked' : 'download failed');
  const blob = await r.blob();
  if (blob.size < 20000) throw new Error('empty audio');
  const imageBlob = state.metaById.has(t.id) ? null : await fetchCover(t.image);
  const meta = { id: t.id, name: t.name, artists: t.artists, album: t.album || '', image: t.image || '', duration_ms: t.duration_ms, size: blob.size, savedAt: Date.now(), imageBlob };
  await db.saveTrack(meta, blob);
  state.metaById.set(t.id, meta); state.saved.add(t.id); updateBadge();
  if (state.cur.id === t.id) { $('#full-save').classList.add('saved'); $('#full-save').title = 'Saved on this phone'; }
}

async function enqueue(tracks) {
  const fresh = tracks.filter(t => !state.saved.has(t.id) && !(state.dl.items && state.dl.items.has(t.id)));
  if (!fresh.length) return 0;
  const items = fresh.map(t => ({ id: t.id, track: t, status: 'pending', attempts: 0, addedAt: Date.now() }));
  await db.qPutMany(items);
  if (!state.dl.items) state.dl.items = new Map();
  items.forEach(i => state.dl.items.set(i.id, i));
  state.dl.total += items.length;
  items.forEach(i => setRowStatus(i.id, 'wait'));
  renderBanner(); runQueue();
  return items.length;
}

function renderBanner() {
  const b = $('#dl-banner'); const d = state.dl;
  const pending = d.items ? Array.from(d.items.values()).filter(i => i.status !== 'failed').length : 0;
  if (!d.total && !pending && !d.failed) return b.classList.add('hidden');
  b.classList.remove('hidden');
  const finished = d.done + d.failed; const pct = d.total ? Math.round((finished / d.total) * 100) : 0;
  $('#dl-ring').style.strokeDashoffset = 97.4 * (1 - pct / 100); $('#dl-ring-pct').textContent = `${pct}%`;
  const activeNames = Array.from(d.active).map(id => d.items && d.items.get(id) ? d.items.get(id).track.name : '').filter(Boolean);
  if (pending) { $('#dl-banner-title').textContent = activeNames[0] ? `Downloading “${activeNames[0]}”` : 'Downloading…'; $('#dl-banner-sub').textContent = `${d.done} of ${d.total} saved${d.failed ? ` · ${d.failed} failed` : ''}${state.online ? '' : ' · waiting for network'}`; }
  else { $('#dl-banner-title').textContent = d.failed ? `Done, ${d.failed} couldn't be found` : 'All songs saved'; $('#dl-banner-sub').textContent = `${d.done} of ${d.total} saved`; }
  $('#dl-retry').classList.toggle('hidden', !(d.failed && !pending));
}

async function runQueue() {
  const d = state.dl;
  if (d.running || !state.online) return;
  d.running = true; d.cancelled = false;
  await ensurePersist();
  if (!d.items) { const all = await db.qAll(); d.items = new Map(all.map(i => [i.id, i])); if (!d.total) d.total = all.length; }
  const next = () => Array.from(d.items.values()).find(i => i.status === 'pending' && !d.active.has(i.id) && (i.nextAt || 0) <= Date.now());
  const anyPending = () => Array.from(d.items.values()).some(i => i.status === 'pending' && !d.active.has(i.id));
  const worker = async () => {
    while (!d.cancelled && state.online) {
      const item = next();
      if (!item) { if (anyPending()) { await sleep(500); continue; } break; }
      d.active.add(item.id); setRowStatus(item.id, 'busy'); renderBanner();
      try {
        await fetchTrack(item.track);
        d.items.delete(item.id); await db.qDel(item.id); d.done++;
        setRowStatus(item.id, 'done'); buzz(10);
      } catch (e) {
        item.attempts++;
        if (e.message === 'blocked' && !d.blockedToast) { d.blockedToast = true; toast('YouTube is blocking the server. Ask the owner to add cookies.', 5000); }
        if (e.message === 'no_match' || e.message === 'blocked' || item.attempts >= MAX_ATTEMPTS) { item.status = 'failed'; d.failed++; setRowStatus(item.id, 'err'); }
        else { item.nextAt = Date.now() + BACKOFF[item.attempts - 1]; setRowStatus(item.id, 'wait'); }
        await db.qPut(item);
      }
      d.active.delete(item.id); renderBanner(); updateDownloadAllLabel();
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  d.running = false;
  const pending = anyPending();
  if (!pending && !d.cancelled) {
    renderBanner(); renderPlaylists();
    if (d.total) { toast(d.failed ? `Done, ${d.failed} couldn't be found` : 'Playlist saved to your phone 🎉', 3000); buzz([20, 60, 20]); }
    if (!d.failed) setTimeout(() => { if (!d.running) { d.total = 0; d.done = 0; renderBanner(); } }, 4000);
  }
}
async function retryFailed() {
  const d = state.dl; const failed = Array.from(d.items.values()).filter(i => i.status === 'failed');
  failed.forEach(i => { i.status = 'pending'; i.attempts = 0; i.nextAt = 0; setRowStatus(i.id, 'wait'); });
  await db.qPutMany(failed); d.failed = 0; renderBanner(); runQueue();
}
async function cancelQueue() {
  const d = state.dl; d.cancelled = true;
  await db.qClear(); if (d.items) { d.items.forEach(i => setRowStatus(i.id, state.saved.has(i.id) ? 'done' : '')); d.items.clear(); }
  d.total = 0; d.done = 0; d.failed = 0; renderBanner(); updateDownloadAllLabel(); toast('Downloads cancelled');
}
async function downloadOne(t) {
  if (state.saved.has(t.id)) return toast('Already saved');
  if (!state.online) return toast('You are offline');
  const n = await enqueue([t]); if (n) toast(`Queued “${t.name}”`, 1500); updateDownloadAllLabel();
}
async function downloadAll() {
  if (!state.online) return toast('You are offline');
  const n = await enqueue(state.tracks);
  toast(n ? `Downloading ${n} songs in the background` : 'Everything is already saved or queued', 2500);
  updateDownloadAllLabel();
}

// ================= Player =================
async function audioUrlFor(id) { const a = await db.audioGet(id); return a ? URL.createObjectURL(a.blob) : null; }
function canPlay(t) { return state.saved.has(t.id) || state.online; }
function playableIndexes() { return state.queue.map((t, i) => canPlay(t) ? i : -1).filter(i => i >= 0); }
function nextIndex(fromAuto) {
  const idx = playableIndexes(); if (!idx.length) return -1;
  if (state.shuffle) { const others = idx.filter(i => i !== state.qIndex); return others.length ? others[Math.floor(Math.random() * others.length)] : -1; }
  const after = idx.find(i => i > state.qIndex);
  if (after != null) return after;
  return (state.repeat || !fromAuto) ? idx[0] : -1;
}
async function playTrack(t, list) {
  const src = list || (state.tab === 'downloads' ? state.savedItems : state.tracks);
  state.queue = src.slice(); state.qIndex = state.queue.findIndex(x => x.id === t.id);
  await loadCurrent();
}
async function loadCurrent() {
  const t = state.queue[state.qIndex]; if (!t) return;
  const saved = state.saved.has(t.id);
  if (!saved && !state.online) return toast('Offline. Download this song first.');
  let url, streaming = false;
  if (saved) {
    if (state.pre.id === t.id && state.pre.url) { url = state.pre.url; state.pre = { id: null, url: null }; }
    else url = await audioUrlFor(t.id);
    if (!url) return toast('Audio missing. Download it again.');
  } else {
    streaming = true;
    url = `/api/download?${new URLSearchParams({ name: t.name, artists: t.artists, duration: t.duration_ms })}`;
  }
  if (state.cur.url) URL.revokeObjectURL(state.cur.url);
  state.cur = { id: t.id, url: saved ? url : null, streaming };
  audio.src = url; audio.play().catch(() => {});
  $('#np-stream').classList.toggle('hidden', !streaming);
  $('#full-label').textContent = streaming ? 'Streaming' : 'Now playing';
  $('#seek').disabled = streaming;
  $('#full-save').classList.toggle('saved', saved); $('#full-save').title = saved ? 'Saved on this phone' : 'Save to phone';
  const img = coverUrl(t);
  $('#player').classList.remove('hidden');
  $('#np-art').src = img; $('#np-name').textContent = t.name; $('#np-artist').textContent = t.artists;
  $('#full-art').src = img; $('#full-bg-img').src = img; $('#full-name').textContent = t.name; $('#full-artist').textContent = t.artists;
  $('#t-dur').textContent = fmtTime(t.duration_ms);
  $$('.track').forEach(li => { const on = li.dataset.id === t.id; li.classList.toggle('playing', on); const num = $('.t-num', li); if (num) num.innerHTML = on ? ICON.eq : String(Array.from(li.parentNode.children).indexOf(li) + 1); });
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({ title: t.name, artist: t.artists, album: t.album || 'Spotiby', artwork: img ? [{ src: img, sizes: '300x300', type: 'image/jpeg' }] : [] });
    const h = (n, f) => { try { navigator.mediaSession.setActionHandler(n, f); } catch {} };
    h('previoustrack', prev); h('nexttrack', () => next(false)); h('play', () => audio.play()); h('pause', () => audio.pause());
    h('seekto', d => { audio.currentTime = d.seekTime; updatePosition(); }); h('seekbackward', d => { audio.currentTime = Math.max(0, audio.currentTime - (d.seekOffset || 10)); }); h('seekforward', d => { audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + (d.seekOffset || 10)); });
  }
  preloadNext();
}
async function preloadNext() {
  const i = state.shuffle ? -1 : nextIndex(true); if (i < 0) return;
  const t = state.queue[i]; if (!t || state.pre.id === t.id || !state.saved.has(t.id)) return;
  if (state.pre.url) URL.revokeObjectURL(state.pre.url);
  const url = await audioUrlFor(t.id); state.pre = url ? { id: t.id, url } : { id: null, url: null };
}
async function next(auto) { const i = nextIndex(auto); if (i < 0) { audio.pause(); return; } state.qIndex = i; await loadCurrent(); }
async function prev() {
  if (audio.currentTime > 3) { audio.currentTime = 0; return; }
  const idx = playableIndexes().filter(i => i < state.qIndex);
  if (idx.length) { state.qIndex = idx[idx.length - 1]; return loadCurrent(); }
  audio.currentTime = 0;
}
function updatePosition() {
  if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
  const dur = effDuration(); if (!dur) return;
  try { navigator.mediaSession.setPositionState({ duration: dur, playbackRate: audio.playbackRate, position: Math.min(audio.currentTime, dur) }); } catch {}
}
function setPlayIcon() {
  const p = audio.paused;
  $('#np-play-icon').innerHTML = p ? ICON.play : ICON.pause; $('#full-play-icon').innerHTML = p ? ICON.play : ICON.pause;
  document.body.classList.toggle('paused', p);
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = p ? 'paused' : 'playing';
  updatePosition();
}
let seeking = false, lastPos = 0;
function effDuration() { if (isFinite(audio.duration) && audio.duration) return audio.duration; const t = state.queue[state.qIndex]; return t ? t.duration_ms / 1000 : 0; }
audio.addEventListener('timeupdate', () => {
  const dur = effDuration(); if (!dur) return;
  const pct = Math.min(100, (audio.currentTime / dur) * 100);
  $('#np-fill').style.width = `${pct}%`;
  if (!seeking) { const s = $('#seek'); s.value = Math.round(pct * 10); s.style.setProperty('--p', `${pct}%`); }
  $('#t-cur').textContent = fmtTime(audio.currentTime * 1000);
  if (Date.now() - lastPos > 5000) { lastPos = Date.now(); updatePosition(); }
});
audio.addEventListener('loadedmetadata', () => { if (isFinite(audio.duration) && audio.duration) $('#t-dur').textContent = fmtTime(audio.duration * 1000); updatePosition(); });
audio.addEventListener('seeked', updatePosition);
audio.addEventListener('ended', () => next(true));
audio.addEventListener('error', () => { toast('Playback error, skipping'); next(true); });
audio.addEventListener('play', setPlayIcon); audio.addEventListener('pause', setPlayIcon);
const togglePlay = () => audio.paused ? audio.play() : audio.pause();
$('#np-play').onclick = togglePlay; $('#full-play').onclick = togglePlay;
$('#np-next').onclick = () => next(false); $('#full-next').onclick = () => next(false);
$('#np-prev').onclick = prev; $('#full-prev').onclick = prev;
const seek = $('#seek');
seek.addEventListener('input', () => { seeking = true; const pct = seek.value / 10; seek.style.setProperty('--p', `${pct}%`); const d = effDuration(); if (d) $('#t-cur').textContent = fmtTime(d * pct * 10); });
seek.addEventListener('change', () => { if (!state.cur.streaming && audio.duration) audio.currentTime = (seek.value / 1000) * audio.duration; seeking = false; });
$('#shuffle-btn').onclick = e => { state.shuffle = !state.shuffle; e.currentTarget.classList.toggle('on', state.shuffle); toast(state.shuffle ? 'Shuffle on' : 'Shuffle off', 1200); preloadNext(); };
$('#repeat-btn').onclick = e => { state.repeat = !state.repeat; e.currentTarget.classList.toggle('on', state.repeat); toast(state.repeat ? 'Repeat on' : 'Repeat off', 1200); };

// Full-screen player
const full = $('#full');
function openFull() { full.classList.remove('hidden', 'closing'); document.body.style.overflow = 'hidden'; }
function closeFull() { full.classList.add('closing'); setTimeout(() => { full.classList.add('hidden'); full.classList.remove('closing'); document.body.style.overflow = ''; }, 260); }
$('#player-open').onclick = openFull; $('#full-close').onclick = closeFull;
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !full.classList.contains('hidden')) closeFull(); if (e.key === ' ' && e.target === document.body && audio.src) { e.preventDefault(); togglePlay(); } });
let touchY = null;
full.addEventListener('touchstart', e => { touchY = e.touches[0].clientY; }, { passive: true });
full.addEventListener('touchend', e => { if (touchY != null && e.changedTouches[0].clientY - touchY > 90) closeFull(); touchY = null; }, { passive: true });

// ================= Wiring =================
$('#download-all').onclick = downloadAll;
$('#dl-retry').onclick = retryFailed; $('#dl-cancel').onclick = cancelQueue;
$('#full-save').onclick = () => { const t = state.queue[state.qIndex]; if (!t) return; if (state.saved.has(t.id)) return toast('Already saved'); downloadOne(t); };
$('#play-all').onclick = () => { const first = state.tracks.find(canPlay); if (!first) return toast('Offline. Download some songs first.'); state.shuffle = false; $('#shuffle-btn').classList.remove('on'); playTrack(first, state.tracks); };
$('#shuffle-all').onclick = () => { const ok = state.tracks.filter(canPlay); if (!ok.length) return toast('Offline. Download some songs first.'); state.shuffle = true; $('#shuffle-btn').classList.add('on'); playTrack(ok[Math.floor(Math.random() * ok.length)], state.tracks); };
$('#play-saved').onclick = () => { if (state.savedItems.length) playTrack(state.savedItems[0], state.savedItems); };
$('#back-btn').onclick = () => { showPage('playlists'); renderPlaylists(); };
$('#link-form').onsubmit = e => { e.preventDefault(); addPublic($('#link-input').value.trim(), $('#link-input'), $('#link-btn')); };
$('#add-form').onsubmit = e => { e.preventDefault(); addPublic($('#add-input').value.trim(), $('#add-input'), $('#add-btn')); };
$('#search-input').oninput = e => { state.search = e.target.value; renderDownloads(); };
$$('.tab').forEach(b => b.onclick = () => { state.tab = b.dataset.tab; if (b.dataset.tab === 'downloads') renderDownloads(); else renderPlaylists(); showPage(b.dataset.tab); });

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
init();
