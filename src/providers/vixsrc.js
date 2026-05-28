// VixSrc / StreamingCommunity provider.
//
// Flusso:
//   1. IMDB → TMDB via api.themoviedb.org/find
//   2. GET vixsrc.to/api/{movie|tv}/{tmdb}[/{s}/{e}] → JSON {src: "/embed/EID?token=..."}
//   3. GET vixsrc.to{src} (con Referer) → HTML con window.masterPlaylist {params:{token,expires},url}
//   4. Compongo URL playlist: {url}?token=...&expires=...[&h=1]
//   5. Stremio si connette via il nostro proxy HLS (/hls/sc/...) per token refresh.
//
// VixSrc serve audio italiano nativamente (a differenza di VidXgo).
// Master playlist scade ~5 min: il proxy rinnova rifacendo il flusso /api → /embed.

const fetch = require('node-fetch');

const VIXSRC_DOMAIN = 'https://vixsrc.to';
// Proxy CF Worker per bypassare il blocco CF di vixsrc.to sugli IP datacenter.
// Se settato, tutte le chiamate /api, /embed, /playlist passano dal Worker.
// I segment veri (sc-uN-XX.vix-content.net) restano diretti, non bloccati.
const VIXSRC_PROXY = (process.env.VIXSRC_PROXY || '').replace(/\/$/, '');
const VIXSRC_BASE = VIXSRC_PROXY || VIXSRC_DOMAIN;
const TMDB_API = 'https://api.themoviedb.org/3';
// API key pubblica (open-source). Sovrascrivibile via env.
const TMDB_KEY = process.env.TMDB_API_KEY || '4ef0d7355d9ffb5151e987764708ce96';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

const COMMON_HEADERS = {
  'User-Agent': UA,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'it-IT,it;q=0.9,en;q=0.8',
  'Referer': `${VIXSRC_DOMAIN}/`,
};

// Header playback verso il CDN VixSrc (stesso dominio, niente sec-ch-ua richiesti).
const PLAYBACK_HEADERS = {
  'User-Agent': UA,
  'Accept': '*/*',
  'Accept-Language': 'it-IT,it;q=0.9,en;q=0.8',
  'Referer': `${VIXSRC_DOMAIN}/`,
  'Origin': VIXSRC_DOMAIN,
};

// Cache IMDB→TMDB per 24h (mapping stabile)
const tmdbCache = new Map();
async function imdbToTmdb(imdbId, kind) {
  const k = `${imdbId}:${kind}`;
  const hit = tmdbCache.get(k);
  if (hit && Date.now() - hit.t < 24 * 60 * 60 * 1000) return hit.v;
  const r = await fetch(`${TMDB_API}/find/${imdbId}?api_key=${TMDB_KEY}&external_source=imdb_id`, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json' },
    timeout: 8000,
  });
  if (!r.ok) throw new Error(`TMDB find -> ${r.status}`);
  const data = await r.json();
  const arr = kind === 'movie' ? data.movie_results : data.tv_results;
  const id = (arr && arr.length) ? arr[0].id : null;
  tmdbCache.set(k, { v: id, t: Date.now() });
  return id;
}

// Rewrite di un URL host (vixsrc.to / *.vix-content.net) → proxy Worker.
// Pattern: https://HOST/PATH → ${VIXSRC_PROXY}/HOST/PATH
// Tutto il flusso passa dal Worker (stesso IP CF) perché vixsrc firma i token
// segment usando l'IP che ha fetchato l'embed → mix di IP = 403 sui segment.
function viaProxy(url) {
  if (!VIXSRC_PROXY) return url;
  const m = url.match(/^https?:\/\/([^/]+)(\/.*)?$/);
  if (!m) return url;
  const host = m[1];
  const rest = m[2] || '/';
  if (host !== 'vixsrc.to' && !/^sc-u\d+-\d+\.vix-content\.net$/.test(host)) return url;
  return `${VIXSRC_PROXY}/${host}${rest}`;
}

// 1) Chiama l'API /api per ottenere /embed/EID?token=...&expires=...
async function getEmbedSrc(tmdbId, season, episode, isMovie) {
  const path = isMovie
    ? `/api/movie/${tmdbId}`
    : `/api/tv/${tmdbId}/${season}/${episode}`;
  const r = await fetch(`${VIXSRC_BASE}${path}`, {
    headers: { ...COMMON_HEADERS, 'Accept': 'application/json,*/*' },
    timeout: 8000,
  });
  if (!r.ok) throw new Error(`vixsrc api ${path} -> ${r.status}`);
  const data = await r.json();
  if (!data || !data.src) throw new Error('vixsrc api: no src');
  return data.src;
}

// 2) Fetcha la pagina /embed e parsa window.masterPlaylist.{params,url} + canPlayFHD
async function getPlaylistInfo(tmdbId, season, episode, isMovie) {
  const src = await getEmbedSrc(tmdbId, season, episode, isMovie);
  // src è del tipo "/embed/EID?token=..." — costruisco usando il base (proxy o originale)
  const embedUrl = src.startsWith('http') ? viaProxy(src) : `${VIXSRC_BASE}${src}`;
  const r = await fetch(embedUrl, { headers: COMMON_HEADERS, timeout: 8000 });
  if (!r.ok) throw new Error(`vixsrc embed -> ${r.status}`);
  const html = await r.text();

  // Estrae i 3 valori dal blocco window.masterPlaylist = { params: {...}, url: '...' }
  const tokenM = html.match(/['"]token['"]\s*:\s*['"]([^'"]+)['"]/);
  const expiresM = html.match(/['"]expires['"]\s*:\s*['"]([^'"]+)['"]/);
  const urlM = html.match(/window\.masterPlaylist\s*=[\s\S]*?url\s*:\s*['"]([^'"]+)['"]/);
  if (!tokenM || !expiresM || !urlM) throw new Error('vixsrc: masterPlaylist parse failed');

  const fhdM = html.match(/window\.canPlayFHD\s*=\s*(true|false)/);
  const fhd = fhdM ? fhdM[1] === 'true' : true;

  // VixSrc include "&h=1" per abilitare il rendition 1080p quando disponibile.
  // La playlist master è ospitata su vixsrc.to → la routing via proxy se attivo
  // (il CDN segment è su *.vix-content.net, non bloccato, va diretto).
  const sep = urlM[1].includes('?') ? '&' : '?';
  const rawMaster = `${urlM[1]}${sep}token=${tokenM[1]}&expires=${expiresM[1]}${fhd ? '&h=1' : ''}`;
  const masterUrl = viaProxy(rawMaster);

  // expires è epoch (s); cap a 4 min per essere conservativi sul refresh
  const expiresMs = Number(expiresM[1]) * 1000;
  const ttl = Math.max(60_000, Math.min(expiresMs - Date.now() - 30_000, 4 * 60 * 1000));
  return {
    url: masterUrl,
    expire: Date.now() + ttl,
  };
}

const masterCache = new Map();
async function getMasterUrlCached(tmdbId, season, episode, isMovie) {
  const k = `${tmdbId}:${season || ''}:${episode || ''}`;
  const entry = masterCache.get(k);
  if (entry && entry.expire - Date.now() > 60_000) return entry;
  const fresh = await getPlaylistInfo(tmdbId, season, episode, isMovie);
  masterCache.set(k, fresh);
  return fresh;
}

async function cdnFetch(url, extraHeaders = {}) {
  // Le sub-playlist (extracted dal master) referenziano ancora vixsrc.to.
  // Routing via proxy se configurato (i segment veri vivono su *.vix-content.net
  // e quelli passano diretti, non bloccati).
  const finalUrl = viaProxy(url);
  return fetch(finalUrl, {
    headers: { ...PLAYBACK_HEADERS, ...extraHeaders },
    timeout: 10000,
    redirect: 'follow',
  });
}

const cache = new Map();
function cacheGet(k) {
  const e = cache.get(k);
  if (!e) return null;
  if (Date.now() - e.t > 4 * 60 * 1000) { cache.delete(k); return null; }
  return e.v;
}
function cacheSet(k, v) {
  if (cache.size >= 200) cache.delete(cache.keys().next().value);
  cache.set(k, { v, t: Date.now() });
}

async function findStream(imdbId, season, episode, isMovie) {
  if (!imdbId || !imdbId.startsWith('tt')) return null;
  const ckey = `sc:${imdbId}:${season || ''}:${episode || ''}`;
  const cached = cacheGet(ckey);
  if (cached) return cached;

  try {
    const tmdbId = await imdbToTmdb(imdbId, isMovie ? 'movie' : 'tv');
    if (!tmdbId) return null;

    const master = await getMasterUrlCached(tmdbId, season, episode, isMovie);
    if (!master.url) return null;

    const out = {
      provider: 'SC',
      tmdbId,
      season: season || null,
      episode: episode || null,
      isMovie: !!isMovie,
      // URL master playlist già firmato. Il proxy /hls/sc/* riscrive le
      // sub-playlist e i segment, e rinnova il token su 403/410.
      masterUrl: master.url,
    };
    cacheSet(ckey, out);
    return out;
  } catch (e) {
    console.error('[VixSrc]', e.message);
    return null;
  }
}

// Risolve segment URL "scaduto" cercandolo nel master fresco.
// Il proxy chiama questa funzione quando un segment risponde 403/410 (token expired).
async function resolveSegmentUrl(tmdbId, season, episode, isMovie, segmentPath) {
  // Forza refresh del master
  masterCache.delete(`${tmdbId}:${season || ''}:${episode || ''}`);
  const master = await getMasterUrlCached(tmdbId, season, episode, isMovie);
  const r = await cdnFetch(master.url);
  if (!r.ok) throw new Error(`master CDN ${r.status}`);
  const masterText = await r.text();
  const playlistLines = masterText.split(/\r?\n/).filter((l) => l && !l.startsWith('#'));
  for (const line of playlistLines) {
    const playlistUrl = line.startsWith('http') ? line : new URL(line, master.url).toString();
    const pr = await cdnFetch(playlistUrl);
    if (!pr.ok) continue;
    const ptext = await pr.text();
    const segs = ptext.split(/\r?\n/).filter((l) => l && !l.startsWith('#'));
    for (const s of segs) {
      const segUrl = s.startsWith('http') ? s : new URL(s, playlistUrl).toString();
      if (segUrl.includes(segmentPath) || segUrl.split('?')[0].endsWith(segmentPath)) {
        return segUrl;
      }
    }
  }
  return null;
}

module.exports = { findStream, getMasterUrlCached, cdnFetch, resolveSegmentUrl, imdbToTmdb };
