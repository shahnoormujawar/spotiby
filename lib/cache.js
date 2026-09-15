// Match cache: remembers which YouTube video matched a track so later downloads skip the search.
// Uses MongoDB when MONGODB_URI is set, otherwise a JSON file in data/. Both are optional and safe to lose.
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'matches.json');
let mode = 'file', col = null, mem = null, saveTimer = null;

async function init() {
  if (process.env.MONGODB_URI) {
    try {
      const { MongoClient } = require('mongodb');
      const client = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
      await client.connect();
      col = client.db(process.env.MONGODB_DB || 'spotiby').collection('matches');
      await col.createIndex({ key: 1 }, { unique: true });
      mode = 'mongo';
      console.log('Match cache: MongoDB');
      return;
    } catch (err) { console.warn('MongoDB unavailable, falling back to file cache:', err.message); }
  }
  try { mem = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { mem = {}; }
  console.log(`Match cache: file (${Object.keys(mem).length} entries)`);
}

const keyOf = ({ name, artists, durationMs }) => `${(artists || '').toLowerCase().trim()}|${(name || '').toLowerCase().trim()}|${Math.round((durationMs || 0) / 1000)}`;

async function get(track) {
  const key = keyOf(track);
  if (mode === 'mongo') { const d = await col.findOne({ key }); return d ? { url: d.url, title: d.title } : null; }
  return mem[key] || null;
}

async function set(track, match) {
  const key = keyOf(track);
  const doc = { url: match.url, title: match.title, hits: 1, updatedAt: new Date() };
  if (mode === 'mongo') { await col.updateOne({ key }, { $set: { key, url: doc.url, title: doc.title, updatedAt: doc.updatedAt }, $inc: { hits: 1 } }, { upsert: true }); return; }
  mem[key] = { url: doc.url, title: doc.title };
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(mem)); } catch (e) { console.error('cache save failed', e.message); } }, 500);
}

async function del(track) {
  const key = keyOf(track);
  if (mode === 'mongo') { await col.deleteOne({ key }); return; }
  delete mem[key];
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { try { fs.writeFileSync(FILE, JSON.stringify(mem)); } catch {} }, 500);
}

module.exports = { init, get, set, del, keyOf };
