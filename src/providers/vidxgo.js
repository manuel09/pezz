// VidXgo provider (= GuardaSerie/StreamingCommunity backend).
//
// Flusso:
//   1. GET https://v.vidxgo.co/{imdb_num}/{season}/{episode}   (movie: niente S/E)
//      con header Firefox 150 + Referer altadefinizione.you
//   2. GET https://v.vidxgo.co/t/{imdb_num}/{season}/{episode}  → JSON {url, expire}
//   3. Restituiamo URL m3u8 a Stremio (con proxyHeaders Chrome 139).
//      Stremio Desktop ha il TLS fingerprint di un browser real e il CDN accetta.
//
// Limite: il manifest e i segment hanno TTL ~5 min. Stremio carica il manifest
// una volta; dopo 5 min i segment scadono. Funziona per anime episodi (~24 min)
// e per la prima parte di film. Per film completi servirebbe un proxy con token rotation.

const fetch = require('node-fetch');

const VIDXGO_DOMAIN = 'https://v.vidxgo.co';

// Header per il GET dell'embed page (Firefox 150 + Referer altadefinizione).
// Sono quelli che StreamVix usa con successo per il primo step.
const GET_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:150.0) Gecko/20100101 Firefox/150.0',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Sec-GPC': '1',
  'Connection': 'keep-alive',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'iframe',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'DNT': '1',
  'Referer': 'https://altadefinizione.you/',
  'Priority': 'u=0, i',
};

// Header playback verso il CDN. Critico: il CDN richiede i Client Hints
// (sec-ch-ua-*) di Chrome, altrimenti risponde 403. Verificato 2026-05-26.
const PLAYBACK_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36',
  'Accept': '*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': `${VIDXGO_DOMAIN}/`,
  'Origin': VIDXGO_DOMAIN,
  'sec-ch-ua': '"Not)A;Brand";v="99", "Chromium";v="139", "Google Chrome";v="139"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Linux"',
  'sec-ch-ua-model': '""',
  'sec-ch-ua-platform-version': '"5.15.0"',
  'sec-ch-ua-full-version-list': '"Not)A;Brand";v="99.0.0.0", "Chromium";v="139.0.7258.66", "Google Chrome";v="139.0.7258.66"',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-site',
};

// Cache delle risposte refresh per 4 min (~80% del TTL)
const cache = new Map();
function cacheGet(k) {
  const e = cache.get(k);
  if (!e) return null;
  if (Date.now() - e.t > 4 * 60 * 1000) {
    cache.delete(k);
    return null;
  }
  return e.v;
}
function cacheSet(k, v) {
  if (cache.size >= 200) cache.delete(cache.keys().next().value);
  cache.set(k, { v, t: Date.now() });
}

// Ottiene fresh master playlist URL signed dal CDN (TTL ~5min).
// La funzione fa /t/{path} → JSON {url, expire}.
async function getMasterUrl(numericId, season, episode, isMovie) {
  const path = isMovie ? numericId : `${numericId}/${season}/${episode}`;
  const refreshRes = await fetch(`${VIDXGO_DOMAIN}/t/${path}`, {
    headers: {
      'User-Agent': GET_HEADERS['User-Agent'],
      'Accept': '*/*',
      'Referer': `${VIDXGO_DOMAIN}/${path}`,
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin',
    },
    timeout: 8000,
  });
  if (!refreshRes.ok) throw new Error(`/t/ -> ${refreshRes.status}`);
  const data = await refreshRes.json();
  if (!data || !data.url) throw new Error('no url in /t/ response');
  return { url: data.url, expire: data.expire || (Date.now() + 4 * 60 * 1000) };
}

// Cache master URL per (imdb, s, e). Rinnova quando vicino alla scadenza.
const masterCache = new Map();
async function getMasterUrlCached(numericId, season, episode, isMovie) {
  const k = `${numericId}:${season || ''}:${episode || ''}`;
  const entry = masterCache.get(k);
  // Refresh se mancano < 60s al expire
  if (entry && entry.expire - Date.now() > 60_000) return entry;
  const fresh = await getMasterUrl(numericId, season, episode, isMovie);
  masterCache.set(k, fresh);
  return fresh;
}

// Fetch CDN URL con header playback corretti (Firefox 150, Referer altadefinizione).
async function cdnFetch(url, extraHeaders = {}) {
  return fetch(url, {
    headers: { ...PLAYBACK_HEADERS, ...extraHeaders },
    timeout: 10000,
    redirect: 'follow',
  });
}

async function findStream(imdbId, season, episode, isMovie) {
  if (!imdbId || !imdbId.startsWith('tt')) return null;
  const numericId = imdbId.replace('tt', '');
  const ckey = `vx:${numericId}:${season || ''}:${episode || ''}`;
  const cached = cacheGet(ckey);
  if (cached) return cached;

  try {
    // Probe: verifica che VidXgo abbia il titolo (chiama embed page, deve essere 200)
    const path = isMovie ? numericId : `${numericId}/${season}/${episode}`;
    const probe = await fetch(`${VIDXGO_DOMAIN}/${path}`, {
      headers: GET_HEADERS,
      timeout: 8000,
      redirect: 'follow',
    });
    if (!probe.ok) return null;

    // Verifico anche che /t/ risponda (a volte la pagina esiste ma niente stream)
    const master = await getMasterUrlCached(numericId, season, episode, isMovie);
    if (!master.url) return null;

    const out = {
      provider: 'GS',
      numericId,
      season: season || null,
      episode: episode || null,
      isMovie: !!isMovie,
    };
    cacheSet(ckey, out);
    return out;
  } catch (e) {
    console.error('[VidXgo]', e.message);
    return null;
  }
}

// Risolve un segment URL "scaduto" trovando la versione fresh nel master corrente.
// Match per "path" del segment (es. seg-0001.ts), ignora i param di token.
async function resolveSegmentUrl(numericId, season, episode, isMovie, segmentPath) {
  const master = await getMasterUrlCached(numericId, season, episode, isMovie);
  // Il master contiene quality playlist. Scarico il master fresco.
  const r = await cdnFetch(master.url);
  if (!r.ok) throw new Error(`master CDN ${r.status}`);
  const masterText = await r.text();
  // Trovo URL di una quality playlist (per HLS multi-bitrate). In casi semplici è l'unica.
  const playlistLines = masterText.split(/\r?\n/).filter((l) => l && !l.startsWith('#'));
  const baseUrl = master.url.replace(/[^\/]+\?.*$/, ''); // dir del master
  for (const line of playlistLines) {
    const playlistUrl = line.startsWith('http') ? line : baseUrl + line;
    const pr = await cdnFetch(playlistUrl);
    if (!pr.ok) continue;
    const ptext = await pr.text();
    const segs = ptext.split(/\r?\n/).filter((l) => l && !l.startsWith('#'));
    for (const s of segs) {
      const segUrl = s.startsWith('http') ? s : new URL(s, playlistUrl).toString();
      // Match per il nome del segment (path component)
      if (segUrl.includes(segmentPath) || segUrl.split('?')[0].endsWith(segmentPath)) {
        return segUrl;
      }
    }
  }
  return null;
}

module.exports = { findStream, getMasterUrlCached, cdnFetch, resolveSegmentUrl };
