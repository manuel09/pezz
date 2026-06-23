// Torbox integration — ispirato a Torrentio (Apache 2.0).
// Chiavi tecniche:
// 1. checkcached: POST con body JSON {hashes: [...]} (no GET)
// 2. requestdl con redirect=true → URL statico, NIENTE fetch per ottenere il link
// 3. find-or-create: cerca prima in mylist, evita rate limit createtorrent
const fetch = require('node-fetch');
const { getConfig } = require('../config');
const { findFileForEpisode } = require('../parse');

const BASE = 'https://api.torbox.app/v1';
const TIMEOUT = 10000;

function authHeaders() {
  return {
    Authorization: `Bearer ${getConfig().torboxKey}`,
    'User-Agent': 'itahub',
  };
}

// Cache mylist per utente (5 min). Mappa hash → torrent.
const mylistCache = new Map();
async function getMylistMap(userKey) {
  const entry = mylistCache.get(userKey);
  if (entry && Date.now() - entry.t < 5 * 60 * 1000) return entry.map;
  try {
    const res = await fetch(`${BASE}/api/torrents/mylist?bypass_cache=true`, {
      headers: { Authorization: `Bearer ${userKey}`, 'User-Agent': 'itahub' },
      timeout: TIMEOUT,
    });
    if (!res.ok) return new Map();
    const json = await res.json();
    const map = new Map();
    for (const t of json?.data || []) {
      if (t.hash) map.set(String(t.hash).toLowerCase(), t);
    }
    mylistCache.set(userKey, { map, t: Date.now() });
    return map;
  } catch (_) {
    return new Map();
  }
}

// Batch check cached usando POST + body {hashes}.
// Restituisce Map(hash → {files, name}) — i `files` servono per:
//  - filtrare i pack che non contengono l'episodio richiesto
//  - sapere in anticipo quale file_id usare quando l'utente clicca play
async function checkCachedBatch(hashes) {
  const map = new Map();
  if (!hashes.length) return map;
  const url = `${BASE}/api/torrents/checkcached?format=list&list_files=true`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ hashes }),
      timeout: TIMEOUT,
    });
    if (!res.ok) return map;
    const json = await res.json();
    const data = json?.data || [];
    for (const r of data) {
      const hash = String(r.hash).toLowerCase();
      // I file dal /checkcached hanno {name, size} per ogni elemento.
      map.set(hash, { files: r.files || [], name: r.name || '' });
    }
    return map;
  } catch (_) {
    return map;
  }
}

// createtorrent con retry su ACTIVE_LIMIT / rate limit.
async function createTorrent(magnet, attempts = 2) {
  const data = new URLSearchParams();
  data.append('magnet', magnet);
  data.append('allow_zip', 'false');
  const res = await fetch(`${BASE}/api/torrents/createtorrent`, {
    method: 'POST',
    headers: authHeaders(),
    body: data,
    timeout: TIMEOUT,
  });
  const json = await res.json().catch(() => ({}));
  if (json?.success && json.data) return json.data;

  // ACTIVE_LIMIT → libera uno slot (stop oldest seeding) e riprova
  if (json?.error === 'ACTIVE_LIMIT' && attempts > 0) {
    await freeLastActiveTorrent();
    return createTorrent(magnet, attempts - 1);
  }
  // 429 rate-limited
  if (res.status === 429 && attempts > 0) {
    await new Promise((r) => setTimeout(r, 1500));
    return createTorrent(magnet, attempts - 1);
  }
  throw new Error(`TB createtorrent failed: ${JSON.stringify(json)}`);
}

async function freeLastActiveTorrent() {
  const map = await getMylistMap(getConfig().torboxKey);
  // Cerca seeding (eligibile a stop) o downloading (eligibile a delete)
  const items = [...map.values()].sort((a, b) => b.id - a.id);
  const seedingStates = ['seeding', 'uploading', 'uploading (no peers)'];
  const seeding = items.find((t) => seedingStates.includes(t.download_state));
  if (seeding) {
    return controlTorrent(seeding.id, 'stop_seeding');
  }
  const downloading = items.find((t) => !t.download_present);
  if (downloading) {
    return controlTorrent(downloading.id, 'delete');
  }
}

async function controlTorrent(torrentId, operation) {
  const res = await fetch(`${BASE}/api/torrents/controltorrent`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ torrent_id: torrentId, operation }),
    timeout: TIMEOUT,
  });
  return res.ok;
}

// URL statico — NIENTE fetch! Stremio segue il redirect direttamente.
function buildDownloadUrl(torrentId, fileId) {
  const token = encodeURIComponent(getConfig().torboxKey);
  return `${BASE}/api/torrents/requestdl?token=${token}&torrent_id=${torrentId}&file_id=${fileId}&redirect=true`;
}

// Sceglie il file giusto: se è specificato S/E (per i pack) cerca il file
// che matcha l'episodio richiesto, altrimenti ritorna il video più grande.
function pickBestFile(torrent, season, episode) {
  if (!torrent || !Array.isArray(torrent.files)) return null;
  const videoRe = /\.(mkv|mp4|avi|mov|webm|m4v|ts)$/i;
  const videos = torrent.files.filter((f) => f && f.short_name && videoRe.test(f.short_name));
  if (!videos.length) return null;
  if (season && episode) {
    // Normalizza i campi: findFileForEpisode si aspetta name/short_name/path
    const match = findFileForEpisode(videos, season, episode);
    if (match) return match;
  }
  // Fallback: file video più grande (default per film o quando S/E non matcha)
  return videos.slice().sort((a, b) => (b.size || 0) - (a.size || 0))[0];
}

async function getStreamUrl(infoHash, magnet, season, episode) {
  const c = getConfig();
  if (!c.torboxKey || !magnet) return null;
  const hash = String(infoHash).toLowerCase();
  try {
    // 1. Cerca in mylist (no API call extra: la mappa è già caricata in cache)
    let map = await getMylistMap(c.torboxKey);
    let torrent = map.get(hash);

    // 2. Se non esiste, crea (con retry su ACTIVE_LIMIT)
    if (!torrent || !torrent.download_present) {
      const created = await createTorrent(magnet);
      if (!created?.torrent_id) return null;
      // Invalido cache mylist per forzare re-fetch al prossimo call (la mappa è stale)
      mylistCache.delete(c.torboxKey);
      map = await getMylistMap(c.torboxKey);
      torrent = map.get(hash) || { id: created.torrent_id, files: [{ id: 0, short_name: 'video.mkv', size: 1 }] };
    }

    const file = pickBestFile(torrent, season, episode) || { id: 0 };
    return buildDownloadUrl(torrent.id, file.id);
  } catch (e) {
    return null;
  }
}

module.exports = { name: 'TB', getStreamUrl, checkCachedBatch, getMylistMap };
