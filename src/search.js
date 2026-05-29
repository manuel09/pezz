const fetch = require('node-fetch');
const {
  parseQuality, formatSize, matchesEpisode, isItalian, hasItalianSub,
  animeProbablyHasItaSub, seriesProbablyHasItaSub,
  isSeasonPack, titleMatches,
  titleMatchesAnimeStrict, matchesAnimeEpisode,
} = require('./parse');
const { getConfig } = require('./config');

// Cache LRU in memoria per evitare di colpire le API a ogni richiesta.
// I tracker pubblici (specialmente Solid) rate-limitano dopo poche query.
const queryCache = new Map();
const CACHE_TTL = 30 * 60 * 1000; // 30 minuti per torrent search
const CACHE_MAX = 1000;

function cacheGet(key) {
  const e = queryCache.get(key);
  if (!e) return null;
  if (Date.now() - e.t > CACHE_TTL) {
    queryCache.delete(key);
    return null;
  }
  // refresh ordine LRU
  queryCache.delete(key);
  queryCache.set(key, e);
  return e.v;
}

function cacheSet(key, value) {
  if (queryCache.size >= CACHE_MAX) {
    const firstKey = queryCache.keys().next().value;
    queryCache.delete(firstKey);
  }
  queryCache.set(key, { v: value, t: Date.now() });
}

async function cached(key, fn) {
  const hit = cacheGet(key);
  if (hit !== null) return hit;
  const v = await fn();
  // Non cachiamo i fallimenti (array vuoti): probabili 429/timeout temporanei.
  if (Array.isArray(v) && v.length > 0) cacheSet(key, v);
  return v;
}

// Cooldown per provider che rate-limitano. Mappa provider → timestamp di sblocco.
const cooldowns = new Map();
function isOnCooldown(provider) {
  const until = cooldowns.get(provider);
  return until && Date.now() < until;
}
function setCooldown(provider, seconds) {
  cooldowns.set(provider, Date.now() + seconds * 1000);
}

// Rimuove accenti e punteggiatura per migliorare il match delle API
// (apibay/Knaben spesso non trovano "Totò" ma trovano "Toto").
// Apostrofi e trattini bassi vengono RIMOSSI senza spazio ("Grey's" → "Greys")
// perché le release torrent usano la versione senza apostrofo nel filename.
function cleanQuery(s) {
  return (s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/['’‘`]/g, '')        // apostrofi: rimossi (Grey's → Greys)
    .replace(/[.……]+/g, ' ')
    .replace(/[:,;!?]/g, ' ')      // punteggiatura → spazio (Law & Order: SVU)
    .replace(/\s+/g, ' ')
    .trim();
}

const TRACKERS = [
  // Generici, alta popolazione
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://tracker.openbittorrent.com:6969/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://tracker.tiny-vps.com:6969/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.dler.org:6969/announce',
  'udp://tracker.moeking.me:6969/announce',
  // Anime / Nyaa
  'http://nyaa.tracker.wf:7777/announce',
  'http://anidex.moe:6969/announce',
  'http://tracker.anirena.com:80/announce',
  'udp://tracker.cyberia.is:6969/announce',
];

function magnetFromHash(hash, name) {
  const trackers = TRACKERS.map((t) => `&tr=${encodeURIComponent(t)}`).join('');
  const dn = name ? `&dn=${encodeURIComponent(name)}` : '';
  return `magnet:?xt=urn:btih:${hash}${dn}${trackers}`;
}

// AbortController wrapper: timeout STRICT (node-fetch 'timeout' option non sempre rispettato).
// Se il server non risponde entro ms, abort la connessione e rilancia AbortError.
async function fetchAbort(url, opts = {}, ms = 4000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
    timeout: 6000,
    ...opts,
  });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
    timeout: 6000,
  });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.text();
}

// --- YTS (film) — API JSON ufficiale, molto stabile ---
async function searchYTS(meta) {
  return cached(`yts:${meta.title}:${meta.year || ''}`, () => searchYTSUncached(meta));
}
async function searchYTSUncached(meta) {
  try {
    const q = encodeURIComponent(meta.title);
    // yts.mx ha problemi DNS intermittenti; yts.am è il mirror ufficiale storico,
    // stesso DB. Override via env per cambiare facilmente in futuro.
    const host = process.env.YTS_HOST || 'yts.am';
    const data = await fetchJson(`https://${host}/api/v2/list_movies.json?query_term=${q}&limit=20`);
    const movies = data?.data?.movies || [];
    const target = (meta.title || '').toLowerCase();
    const results = [];
    for (const m of movies) {
      if (meta.year && m.year && String(m.year) !== String(meta.year)) continue;
      if (!m.title_long?.toLowerCase().includes(target.split(' ')[0])) continue;
      for (const t of m.torrents || []) {
        results.push({
          title: `${m.title_long} ${t.quality} ${t.type} [YTS]`,
          infoHash: t.hash.toLowerCase(),
          magnet: magnetFromHash(t.hash.toLowerCase(), `${m.title_long} ${t.quality}`),
          seeds: t.seeds,
          peers: t.peers,
          sizeText: t.size,
          quality: t.quality,
          trackers: TRACKERS,
          provider: 'YTS',
          italian: isItalian(m.title_long),
          italianSub: hasItalianSub(m.title_long),
        });
      }
    }
    return results;
  } catch (e) {
    console.error('[YTS]', e.message);
    return [];
  }
}

// --- EZTV (serie TV) — API JSON via IMDB id ---
async function searchEZTV(meta, imdbId) {
  const key = `eztv:${imdbId}:${meta.season || ''}:${meta.episode || ''}`;
  return cached(key, () => searchEZTVUncached(meta, imdbId));
}
async function searchEZTVUncached(meta, imdbId) {
  try {
    const id = imdbId.replace(/^tt/, '');
    // eztvx.to / eztv.re / eztv.ag / eztv.ch ritornano 403 da IP cloud.
    // eztv.tf e eztv.wf rispondono OK. Override via env EZTV_HOST.
    const host = process.env.EZTV_HOST || 'eztv.tf';
    const data = await fetchJson(`https://${host}/api/get-torrents?imdb_id=${id}&limit=100`);
    const torrents = data?.torrents || [];
    const results = [];
    for (const t of torrents) {
      const hash = (t.hash || '').toLowerCase();
      if (!hash) continue;
      if (meta.season && meta.episode) {
        if (Number(t.season) !== meta.season || Number(t.episode) !== meta.episode) {
          if (!matchesEpisode(t.title || '', meta.season, meta.episode)) continue;
        }
      }
      results.push({
        title: `${t.title} [EZTV]`,
        infoHash: hash,
        magnet: t.magnet_url || magnetFromHash(hash, t.title),
        seeds: Number(t.seeds) || 0,
        peers: Number(t.peers) || 0,
        sizeText: formatSize(Number(t.size_bytes)),
        quality: parseQuality(t.title || ''),
        trackers: TRACKERS,
        provider: 'EZTV',
        italian: isItalian(t.title || ''),
        italianSub: hasItalianSub(t.title || ''),
      });
    }
    return results;
  } catch (e) {
    console.error('[EZTV]', e.message);
    return [];
  }
}

// --- SolidTorrents (ottimo per release ITA, API JSON) ---
// Lock + gap minimo per non sparare 5-10 query in parallelo (causava 429).
// Solid è chiamato da searchTorrents (movie/series/anime) + searchTrio →
// senza serializzazione potevano partire ~10 chiamate concorrenti.
let _solidLock = Promise.resolve();
let _lastSolid = 0;
const SOLID_GAP_MS = 800;
async function searchSolid(query) {
  if (isOnCooldown('solid')) return [];
  return cached(`solid:${query}`, () => {
    const job = _solidLock.then(async () => {
      // Re-check cooldown DOPO aver aspettato il lock: se la prima chiamata
      // ha settato cooldown (es. timeout/429), le successive in fila evitano
      // di aspettare un altro timeout inutile.
      if (isOnCooldown('solid')) return [];
      const sinceLast = Date.now() - _lastSolid;
      if (sinceLast < SOLID_GAP_MS) {
        await new Promise((r) => setTimeout(r, SOLID_GAP_MS - sinceLast));
      }
      _lastSolid = Date.now();
      return searchSolidUncached(query);
    });
    _solidLock = job.catch(() => undefined);
    return job;
  });
}
async function searchSolidUncached(query) {
  try {
    // .eu mirror: il .to principale blocca IP cloud (verifica 2026-05-27).
    // .eu serve la stessa API senza CF anti-bot.
    const host = process.env.SOLID_HOST || 'solidtorrents.eu';
    const url = `https://${host}/api/v1/search?q=${encodeURIComponent(query)}&sort=seeders`;
    const res = await fetchAbort(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
    }, 4000);
    if (res.status === 429) {
      setCooldown('solid', 300);
      console.error('[Solid] 429 rate-limited, cooldown 5min');
      return [];
    }
    if (res.status === 403) {
      setCooldown('solid', 3600);
      return [];
    }
    if (!res.ok) {
      console.error(`[Solid] ${url} -> ${res.status}`);
      return [];
    }
    const data = await res.json();
    const results = data?.results || [];
    return results
      .filter((r) => r.infohash)
      .map((r) => {
        const hash = String(r.infohash).toLowerCase();
        return {
          title: `${r.title} [Solid]`,
          infoHash: hash,
          magnet: magnetFromHash(hash, r.title),
          seeds: Number(r.swarm?.seeders) || 0,
          peers: Number(r.swarm?.leechers) || 0,
          sizeText: formatSize(Number(r.size)),
          quality: parseQuality(r.title || ''),
          trackers: TRACKERS,
          provider: 'Solid',
          italian: isItalian(r.title || ''),
          italianSub: hasItalianSub(r.title || ''),
        };
      });
  } catch (e) {
    // Timeout/DNS/connection err → cooldown 10min così non bloccano /stream
    if (/timeout|ETIMEDOUT|ENOTFOUND|ECONNRESET|ECONNREFUSED|EAI_AGAIN/i.test(e.message || '')) {
      setCooldown('solid', 600);
      console.error('[Solid] network err → cooldown 10min:', e.message);
    } else {
      console.error('[Solid]', e.message);
    }
    return [];
  }
}

// --- Knaben (aggregatore multi-tracker) — JSON API ---
async function searchKnaben(query) {
  return cached(`knaben:${query}`, () => searchKnabenUncached(query));
}
async function searchKnabenUncached(query) {
  try {
    const res = await fetch('https://api.knaben.org/v1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
      timeout: 7000,
      body: JSON.stringify({
        search_type: '100%',
        query,
        order_by: 'seeders',
        order_direction: 'desc',
        size: 50,
      }),
    });
    if (!res.ok) return [];
    const data = await res.json();
    const hits = data?.hits || [];
    return hits
      .filter((h) => h.hash)
      .map((h) => {
        const hash = String(h.hash).toLowerCase();
        return {
          title: `${h.title} [Knaben]`,
          infoHash: hash,
          magnet: h.magnetUrl || magnetFromHash(hash, h.title),
          seeds: Number(h.seeders) || 0,
          peers: Number(h.peers) || 0,
          sizeText: formatSize(Number(h.bytes)),
          quality: parseQuality(h.title || ''),
          trackers: TRACKERS,
          provider: 'Knaben',
          italian: isItalian(h.title || ''),
          italianSub: hasItalianSub(h.title || ''),
        };
      });
  } catch (e) {
    console.error('[Knaben]', e.message);
    return [];
  }
}

// --- apibay (Pirate Bay, JSON) — catch-all ---
async function searchApibaySingle(query) {
  return cached(`apibay:${query}`, () => searchApibaySingleUncached(query));
}
async function searchApibaySingleUncached(query) {
  if (isOnCooldown('apibay')) return [];
  try {
    const host = process.env.APIBAY_HOST || 'apibay.org';
    const r = await fetch(`https://${host}/q.php?q=${encodeURIComponent(query)}`, { timeout: 6000 });
    if (r.status === 403) {
      setCooldown('apibay', 3600); // IP cloud bloccato 1h
      return [];
    }
    if (!r.ok) return [];
    const data = await r.json();
    if (!Array.isArray(data) || data[0]?.name === 'No results returned') return [];
    return data
      .filter((r) => r.info_hash && r.info_hash !== '0000000000000000000000000000000000000000')
      .map((r) => ({
        title: `${r.name} [TPB]`,
        infoHash: r.info_hash.toLowerCase(),
        magnet: magnetFromHash(r.info_hash.toLowerCase(), r.name),
        seeds: Number(r.seeders) || 0,
        peers: Number(r.leechers) || 0,
        sizeText: formatSize(Number(r.size)),
        quality: parseQuality(r.name),
        trackers: TRACKERS,
        provider: 'TPB',
        italian: isItalian(r.name),
        italianSub: hasItalianSub(r.name),
      }));
  } catch (e) {
    console.error('[apibay]', e.message);
    return [];
  }
}

// Helper: stessa query lanciata in parallelo su Bitsearch + Knaben + Solid.
// Usato per le query dove apibay sarebbe bloccato (IP cloud) — più hash
// catturati da indexer diversi che non hanno block lato Render.
async function searchTrio(query) {
  const buckets = await Promise.all([
    searchBitsearch(query).catch(() => []),
    searchKnaben(query).catch(() => []),
    searchSolid(query).catch(() => []),
  ]);
  const seen = new Set();
  const out = [];
  for (const list of buckets) for (const r of list) {
    if (!r.infoHash || seen.has(r.infoHash)) continue;
    seen.add(r.infoHash);
    out.push(r);
  }
  return out;
}

// Doppia query: titolo normale + titolo+"ita" per pescare i release italiani
async function searchApibay(query) {
  const [base, ita] = await Promise.all([
    searchApibaySingle(query),
    searchApibaySingle(`${query} ita`),
  ]);
  const merged = [...base];
  const seen = new Set(base.map((r) => r.infoHash));
  for (const r of ita) {
    if (!seen.has(r.infoHash)) {
      seen.add(r.infoHash);
      merged.push(r);
    }
  }
  return merged;
}

// --- ilCorSaRoNeRo — il principale tracker italiano (raggiungibile solo da cloud).
// Multi-mirror fallback: se uno è giù/bloccato, prova il successivo.
const CORSARO_HOSTS = [
  'ilcorsaronero.link',
  'ilcorsaronero.fans',
  'ilcorsaronero.casino',
];
async function searchCorsaro(query) {
  if (isOnCooldown('corsaro')) return [];
  return cached(`corsaro:${query}`, () => searchCorsaroUncached(query));
}
async function searchCorsaroUncached(query) {
  // Tentativo PARALLELO sui mirror — Promise.any vince con la prima risposta valida.
  const tries = CORSARO_HOSTS.map(async (host) => {
    const url = `https://${host}/argomenti/0/?search=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
      timeout: 5000,
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    return res.text();
  });

  let html;
  try {
    html = await Promise.any(tries);
  } catch (_) {
    setCooldown('corsaro', 120);
    return [];
  }

  // Pattern HTML ilCorSaRoNeRo: l'hash è il path della URL /details/HASH.
  // Catturo coppie (hash, titolo) con regex permissiva.
  const matches = [...html.matchAll(/href="\/(?:details|tdetail\.php\?id=)([a-fA-F0-9]{40})[^"]*"[^>]*>\s*<?b?>?([^<]+)/gi)];
  const seen = new Set();
  const results = [];
  for (const m of matches) {
    const hash = m[1].toLowerCase();
    if (seen.has(hash)) continue;
    seen.add(hash);
    const name = m[2].trim().replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ');
    if (!name || name.length < 4) continue;
    results.push({
      title: `${name} [CSR]`,
      infoHash: hash,
      magnet: magnetFromHash(hash, name),
      seeds: 0,
      peers: 0,
      sizeText: null,
      quality: parseQuality(name),
      trackers: TRACKERS,
      provider: 'CSR',
      italian: true,
    });
  }
  return results;
}

// --- Bitsearch — HTML scrape, no rate limit aggressivo ---
async function searchBitsearch(query) {
  if (isOnCooldown('bitsearch')) return [];
  return cached(`bs:${query}`, () => searchBitsearchUncached(query));
}
async function searchBitsearchUncached(query) {
  try {
    // Bitsearch.to ritorna 403 dai IP cloud (Render). Lo storico .to fa 301
    // a .eu, quindi usiamo direttamente il mirror funzionante .eu.
    const host = process.env.BITSEARCH_HOST || 'bitsearch.eu';
    const url = `https://${host}/search?q=${encodeURIComponent(query)}`;
    const res = await fetchAbort(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
    }, 4000);
    if (res.status === 429) {
      setCooldown('bitsearch', 120);
      return [];
    }
    if (res.status === 403) {
      // Cloud IP bloccato: cooldown 1h così non spreco round-trip a vuoto.
      setCooldown('bitsearch', 3600);
      console.error(`[Bitsearch] 403 da ${host} (probabile blocco cloud), cooldown 1h`);
      return [];
    }
    if (!res.ok) return [];
    const html = await res.text();
    // Pattern: ogni torrent ha un <a href="magnet:?xt=urn:btih:HASH&dn=NAME&...">
    // Estraggo coppie uniche (hash, name)
    const matches = [...html.matchAll(/btih:([a-fA-F0-9]{40})&amp;dn&#x3[Dd];?([^"&]+)/gi)];
    const seen = new Set();
    const results = [];
    for (const m of matches) {
      const hash = m[1].toLowerCase();
      if (seen.has(hash)) continue;
      seen.add(hash);
      let name = decodeURIComponent(m[2].replace(/\+/g, ' '));
      // Bitsearch antepone "[Bitsearch.to] " al dn
      name = name.replace(/^\[Bitsearch\.to\]\s*/i, '');
      results.push({
        title: `${name} [BS]`,
        infoHash: hash,
        magnet: magnetFromHash(hash, name),
        seeds: 0, // non disponibile direttamente nell'HTML in modo affidabile
        peers: 0,
        sizeText: null,
        quality: parseQuality(name),
        trackers: TRACKERS,
        provider: 'BS',
        italian: isItalian(name),
        italianSub: hasItalianSub(name),
      });
    }
    return results;
  } catch (e) {
    // Timeout/DNS → cooldown 10min per non bloccare /stream
    if (/timeout|ETIMEDOUT|ENOTFOUND|ECONNRESET|ECONNREFUSED|EAI_AGAIN/i.test(e.message || '')) {
      setCooldown('bitsearch', 600);
      console.error('[Bitsearch] network err → cooldown 10min:', e.message);
    } else {
      console.error('[Bitsearch]', e.message);
    }
    return [];
  }
}

// --- TokyoTosho (anime) — HTML scrape. Hash spesso in base32, converto a hex.
// Torrentio lo usa come fonte primaria insieme a Nyaa, lo scrapo direttamente
// così non dipendo dal proxy esterno (timeout / circuit breaker).
async function searchTokyoTosho(query) {
  if (isOnCooldown('tokyotosho')) return [];
  return cached(`tt:${query}`, () => searchTokyoToshoUncached(query));
}
// Base32 RFC4648 → hex (32 char → 40 char)
function base32ToHex(b32) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of b32.toUpperCase()) {
    const v = alphabet.indexOf(c);
    if (v < 0) return null;
    bits += v.toString(2).padStart(5, '0');
  }
  // 32 char base32 = 160 bit. Prendo i primi 160 bit e converto a 40 hex.
  bits = bits.slice(0, 160);
  let hex = '';
  for (let i = 0; i < bits.length; i += 4) {
    hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  }
  return hex;
}
async function searchTokyoToshoUncached(query) {
  try {
    // type=1 = anime, type=0 = tutto. Uso 1 per filtrare upstream.
    const url = `https://www.tokyotosho.info/search.php?terms=${encodeURIComponent(query)}&type=1`;
    const res = await fetchAbort(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
    }, 5000);
    if (res.status === 429) { setCooldown('tokyotosho', 120); return []; }
    if (res.status === 403) { setCooldown('tokyotosho', 3600); return []; }
    if (!res.ok) return [];
    const html = await res.text();
    // Pattern: ogni torrent ha 2 <tr>. Nel primo: magnet + titolo.
    // <a href="magnet:?xt=urn:btih:HASH...">...</a> <a rel="nofollow" type="application/x-bittorrent" href="...">TITOLO</a>
    // HASH può essere base32 (32 char A-Z2-7) o hex (40 char a-f0-9).
    const rowRe = /href="(magnet:\?xt=urn:btih:([A-Z2-7]{32}|[a-fA-F0-9]{40})[^"]*)"[^>]*>[\s\S]*?<a[^>]+type="application\/x-bittorrent"[^>]*>([^<]+)<\/a>/g;
    const results = [];
    const seen = new Set();
    let m;
    while ((m = rowRe.exec(html)) !== null) {
      const magnet = m[1].replace(/&amp;/g, '&');
      let hash = m[2];
      if (hash.length === 32) hash = base32ToHex(hash);
      if (!hash || hash.length !== 40) continue;
      hash = hash.toLowerCase();
      if (seen.has(hash)) continue;
      seen.add(hash);
      const name = m[3].trim();
      results.push({
        title: `${name} [TT]`,
        infoHash: hash,
        magnet, // contiene già trackers dal sito
        seeds: 0, // estraibili ma non necessari (filtri si basano su altri criteri)
        peers: 0,
        sizeText: null,
        quality: parseQuality(name),
        trackers: TRACKERS,
        provider: 'TT',
        italian: isItalian(name),
        italianSub: hasItalianSub(name),
      });
    }
    return results;
  } catch (e) {
    if (/timeout|ETIMEDOUT|ENOTFOUND|ECONNRESET|ECONNREFUSED|EAI_AGAIN/i.test(e.message || '')) {
      setCooldown('tokyotosho', 600);
      console.error('[TokyoTosho] network err → cooldown 10min:', e.message);
    } else {
      console.error('[TokyoTosho]', e.message);
    }
    return [];
  }
}

// --- Nyaa (anime) — RSS scrape, rate-limit ~10 req/min ---
async function searchNyaa(query) {
  if (isOnCooldown('nyaa')) return [];
  return cached(`nyaa:${query}`, () => searchNyaaUncached(query));
}
async function searchNyaaUncached(query) {
  try {
    const res = await fetch(`https://nyaa.si/?page=rss&q=${encodeURIComponent(query)}&c=1_2&f=0`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
      timeout: 7000,
    });
    if (res.status === 429) {
      setCooldown('nyaa', 60);
      console.error('[Nyaa] 429 cooldown 60s');
      return [];
    }
    if (!res.ok) return [];
    const xml = await res.text();
    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)];
    const results = [];
    for (const m of items) {
      const block = m[1];
      const name = (block.match(/<title>(.*?)<\/title>/) || [])[1] || '';
      const link = (block.match(/<link>(.*?)<\/link>/) || [])[1] || '';
      const hashMatch = block.match(/<nyaa:infoHash>(.*?)<\/nyaa:infoHash>/);
      const seedsMatch = block.match(/<nyaa:seeders>(.*?)<\/nyaa:seeders>/);
      const sizeMatch = block.match(/<nyaa:size>(.*?)<\/nyaa:size>/);
      const hash = hashMatch ? hashMatch[1].toLowerCase() : null;
      if (!hash) continue;
      results.push({
        title: `${name} [Nyaa]`,
        infoHash: hash,
        magnet: magnetFromHash(hash, name),
        seeds: seedsMatch ? Number(seedsMatch[1]) : 0,
        peers: 0,
        sizeText: sizeMatch ? sizeMatch[1] : null,
        quality: parseQuality(name),
        trackers: TRACKERS,
        provider: 'Nyaa',
        italian: isItalian(name),
        italianSub: hasItalianSub(name),
      });
    }
    return results;
  } catch (e) {
    console.error('[Nyaa]', e.message);
    return [];
  }
}

function buildSeriesQuery(meta) {
  const s = String(meta.season).padStart(2, '0');
  const e = String(meta.episode).padStart(2, '0');
  return `${meta.title} S${s}E${e}`;
}

async function searchTorrents(meta, type, imdbId) {
  let buckets = [];

  // Anime: rilevati dal tipo meta dato da cinemeta.js (anche se Stremio invia type='series')
  const isAnime = type === 'anime' || meta.type === 'anime';
  const effectiveType = isAnime ? 'anime' : type;

  // Lang dalla config utente (default 'it' = comportamento storico invariato).
  // Usato sotto per skippare le query ITA-biased quando lang='en'.
  const _lang = (() => { try { return getConfig().lang || 'it'; } catch (_) { return 'it'; } })();

  if (effectiveType === 'movie') {
    const cleanTitle = cleanQuery(meta.title);
    const cleanItalianTitle = meta.italianTitle && meta.italianTitle !== meta.title
      ? cleanQuery(meta.italianTitle) : null;
    const q = meta.year ? `${cleanTitle} ${meta.year}` : cleanTitle;
    const qIta = `${cleanTitle}${meta.year ? ' ' + meta.year : ''} ita`;
    const qItalianTitle = cleanItalianTitle
      ? `${cleanItalianTitle}${meta.year ? ' ' + meta.year : ''}` : null;
    // Branching su lang: lang='it' (default) → query ITA-biased come sempre.
    // lang='en' → solo query neutre (cleanTitle + year). Skip mircrew/nahom/qIta
    // (release group italiani) e skip qItalianTitle (titolo localizzato ITA).
    const skipItaQueries = _lang === 'en';
    // Solid: 1 sola query (è permissivo, ITA emergono comunque). Bitsearch ulteriore fonte ITA.
    const baseSearches = [
      searchYTS(meta),
      searchApibay(q),                  // se IP cloud 403, cooldown 1h
      searchApibaySingle(cleanTitle),
      searchTrio(q),                    // fallback indipendente da apibay
      searchTrio(cleanTitle),
      searchKnaben(q),
      searchSolid(q),
      searchBitsearch(cleanTitle),
    ];
    const itaSearches = skipItaQueries ? [] : [
      searchApibaySingle(qIta),
      searchTrio(qIta),
      searchKnaben(qIta),
      searchBitsearch(qIta),
      // Release group italiani mirati su più indexer per ampliare il pool ITA.
      searchBitsearch(`mircrew ${cleanTitle}`),
      searchBitsearch(`nahom ${cleanTitle}`),
      searchKnaben(`mircrew ${cleanTitle}`),
      searchKnaben(`nahom ${cleanTitle}`),
      searchApibaySingle(`mircrew ${cleanTitle}`),
      searchApibaySingle(`nahom ${cleanTitle}`),
      searchBitsearch(`mem ${cleanTitle}`),
      searchBitsearch(`fhc ${cleanTitle}`),
      // Titolo italiano localizzato (es. "Il padrino" per "The Godfather").
      qItalianTitle ? searchBitsearch(qItalianTitle) : Promise.resolve([]),
      qItalianTitle ? searchKnaben(qItalianTitle) : Promise.resolve([]),
      qItalianTitle ? searchApibaySingle(qItalianTitle) : Promise.resolve([]),
    ];
    buckets = await Promise.all([...baseSearches, ...itaSearches]);
  } else if (effectiveType === 'series') {
    const cleanTitle = cleanQuery(meta.title);
    const cleanItalianTitle = meta.italianTitle && meta.italianTitle !== meta.title
      ? cleanQuery(meta.italianTitle) : null;
    const cleanMeta = { ...meta, title: cleanTitle };
    const q = meta.season && meta.episode ? buildSeriesQuery(cleanMeta) : cleanTitle;
    const sPadded = meta.season ? String(meta.season).padStart(2, '0') : null;
    const ePadded = meta.episode ? String(meta.episode).padStart(2, '0') : null;
    const qItaEp = sPadded && ePadded ? `${cleanTitle} ${meta.season}x${ePadded} ita` : null;
    const qItaSeason = sPadded ? `${cleanTitle} S${sPadded} ita` : null;
    const qItalianTitleSeason = cleanItalianTitle && sPadded
      ? `${cleanItalianTitle} S${sPadded}` : null;
    const qItalianTitleEp = cleanItalianTitle && sPadded && ePadded
      ? `${cleanItalianTitle} S${sPadded}E${ePadded}` : null;
    const skipItaQueries = _lang === 'en';
    const baseSearches = [
      imdbId ? searchEZTV(meta, imdbId) : Promise.resolve([]),
      searchApibay(q),
      searchTrio(q),
      searchKnaben(q),
      searchSolid(q),
    ];
    const itaSearches = skipItaQueries ? [] : [
      qItaEp ? searchApibaySingle(qItaEp) : Promise.resolve([]),
      qItaSeason ? searchApibaySingle(qItaSeason) : Promise.resolve([]),
      // Fallback Trio (Bitsearch+Knaben+Solid) sulle stesse query, indipendenti
      // dal blocco IP cloud che colpisce apibay su Render.
      qItaEp ? searchTrio(qItaEp) : Promise.resolve([]),
      qItaSeason ? searchTrio(qItaSeason) : Promise.resolve([]),
      qItaSeason ? searchKnaben(qItaSeason) : Promise.resolve([]),
      qItaSeason ? searchBitsearch(qItaSeason) : Promise.resolve([]),
      qItaEp ? searchBitsearch(qItaEp) : Promise.resolve([]),
      // Release group italiani mirati su più indexer per ampliare il pool ITA.
      qItaSeason ? searchBitsearch(`mircrew ${cleanTitle} ${sPadded}`) : Promise.resolve([]),
      qItaSeason ? searchKnaben(`mircrew ${cleanTitle} ${sPadded}`) : Promise.resolve([]),
      qItaSeason ? searchApibaySingle(`mircrew ${cleanTitle} ${sPadded}`) : Promise.resolve([]),
      qItaSeason ? searchBitsearch(`nahom ${cleanTitle} ${sPadded}`) : Promise.resolve([]),
      qItaSeason ? searchBitsearch(`mem ${cleanTitle} ${sPadded}`) : Promise.resolve([]),
      // Titolo italiano localizzato (es. "Il Mentalista" per "The Mentalist").
      qItalianTitleSeason ? searchBitsearch(qItalianTitleSeason) : Promise.resolve([]),
      qItalianTitleSeason ? searchKnaben(qItalianTitleSeason) : Promise.resolve([]),
      qItalianTitleSeason ? searchApibaySingle(qItalianTitleSeason) : Promise.resolve([]),
      qItalianTitleEp ? searchBitsearch(qItalianTitleEp) : Promise.resolve([]),
      qItalianTitleEp ? searchApibaySingle(qItalianTitleEp) : Promise.resolve([]),
    ];
    buckets = await Promise.all([...baseSearches, ...itaSearches]);
  } else if (effectiveType === 'anime') {
    // === FLOW ANIME (separato dai film) ===
    const cleanTitle = cleanQuery(meta.title);
    const sPadded = meta.season ? String(meta.season).padStart(2, '0') : null;
    const ePadded = meta.episode ? String(meta.episode).padStart(2, '0') : null;
    const absPadded = meta.absoluteEpisode ? String(meta.absoluteEpisode).padStart(2, '0') : null;

    // Nyaa: query mirate (rate limit aggressivo)
    const nyaaQueries = [];
    if (absPadded) nyaaQueries.push(`${cleanTitle} ${absPadded}`);
    if (sPadded && ePadded) {
      nyaaQueries.push(`${cleanTitle} S${sPadded}E${ePadded}`);
      if (meta.season >= 2) {
        const ord = `${meta.season}${meta.season === 2 ? 'nd' : meta.season === 3 ? 'rd' : 'th'}`;
        nyaaQueries.push(`${cleanTitle} ${ord} Season ${ePadded}`);
      }
    }
    if (!nyaaQueries.length) nyaaQueries.push(cleanTitle);
    // Query lingua-specifiche per gli anime su Nyaa. Lang dalla config utente:
    //   'it' (default): solo modificatore "ITA" → release group italiani
    //     (Tenebra, Wolverine, ItalianShare, ecc.)
    //   'en': solo gruppi EN noti (SubsPlease, Erai-raws, Judas) → sub EN
    //   'mixed': entrambi → pool più grande
    // Backward compat: link IT esistenti hanno lang=undefined → 'it' → identico.
    const _lang = (() => { try { return getConfig().lang || 'it'; } catch (_) { return 'it'; } })();
    const wantITA = _lang !== 'en';
    const wantENG = _lang !== 'it';
    if (wantITA) {
      if (absPadded) {
        nyaaQueries.push(`${cleanTitle} ${absPadded} ITA`);
      } else if (sPadded && ePadded) {
        nyaaQueries.push(`${cleanTitle} S${sPadded}E${ePadded} ITA`);
      } else {
        nyaaQueries.push(`${cleanTitle} ITA`);
      }
    }
    if (wantENG) {
      // Gruppi EN più stabili 2026: SubsPlease (sub EN settimanali), Erai-raws
      // (sub EN multi-track), Judas (HEVC), HorribleSubs (legacy).
      const enGroups = ['SubsPlease', 'Erai-raws'];
      for (const g of enGroups) {
        if (absPadded) nyaaQueries.push(`${cleanTitle} ${absPadded} ${g}`);
        else if (sPadded && ePadded) nyaaQueries.push(`${cleanTitle} S${sPadded}E${ePadded} ${g}`);
        else nyaaQueries.push(`${cleanTitle} ${g}`);
      }
    }

    // Le altre fonti hanno meno rate limit, possiamo fare più query
    const otherQueries = [];
    if (absPadded) otherQueries.push(`${cleanTitle} ${absPadded}`);
    if (sPadded && ePadded) otherQueries.push(`${cleanTitle} S${sPadded}E${ePadded}`);
    if (!otherQueries.length) otherQueries.push(cleanTitle);

    buckets = await Promise.all([
      ...nyaaQueries.map((q) => searchNyaa(q)),
      // TokyoTosho: stessa fonte primary che usa Torrentio per anime. Scrapato
      // direttamente per non dipendere dal timeout/breaker dell'aggregator.
      ...nyaaQueries.map((q) => searchTokyoTosho(q)),
      ...otherQueries.map((q) => searchApibay(q)),
      ...otherQueries.map((q) => searchKnaben(q)),
      ...otherQueries.map((q) => searchSolid(q)),
      ...otherQueries.map((q) => searchBitsearch(q)),
    ]);
  }

  const seen = new Set();
  const out = [];
  for (const bucket of buckets) {
    for (const r of bucket) {
      if (seen.has(r.infoHash)) continue;
      seen.add(r.infoHash);

      // === FILTRO ANIME (separato, no impatto film/serie tradizionali) ===
      if (effectiveType === 'anime') {
        // 1) Titolo + scarta spinoff (Vigilantes, Movie, OVA, ...)
        if (!titleMatchesAnimeStrict(r.title, meta)) continue;
        // 2) Episodio: SxxExx o assoluto. Niente pack stagione.
        if (meta.season && meta.episode) {
          if (!matchesAnimeEpisode(r.title, meta.season, meta.episode, meta.absoluteEpisode)) continue;
        }
        // 3) Filtro lingua condizionato sulla config dell'utente:
        //    'it' (default): SOLO release ITA/sub-ITA/multi-sub-ITA (Erai-raws, ToonsHub, ASW)
        //    'en': accetta TUTTO il pool anime — Nyaa/TokyoTosho/AniDex sono già EN-native
        //          (SubsPlease/Erai-raws/Judas sub EN, BD-rips dub EN, ecc.)
        if (_lang === 'en') {
          // Marca quello che riconosciamo come EN per il tier sort sotto
          if (r.english === undefined) {
            // Usa il modulo parse esposto in cima (non ricarico). Detection inline.
            const nm = r.title || '';
            // Group EN noti per sub: SubsPlease, Erai-raws, Judas, HorribleSubs
            // Group dub EN: vari (sentai, funimation, US BD-rip)
            const ENG_GROUPS = /\b(?:subs?please|erai-raws|judas|horriblesubs|coalgirls|commie|underwater|deadfish|sentai|funimation|crunchyroll)\b/i;
            const HAS_ENG_DUB = /\b(?:english\s?dub|en[-_ ]?dub|eng[-_ ]?dub|dub[-_ ]?eng|funimation\s?dub)\b/i;
            if (HAS_ENG_DUB.test(nm)) { r.english = true; r.englishSub = false; }
            else if (ENG_GROUPS.test(nm)) { r.english = false; r.englishSub = true; }
            else { r.english = false; r.englishSub = true; } // anime su Nyaa default = sub EN
          }
        } else {
          if (!r.italian && !r.italianSub && !animeProbablyHasItaSub(r.title)) continue;
          // Marca come sub ITA quando viene da group multi-sub
          if (!r.italian && !r.italianSub) r.italianSub = true;
        }
        out.push(r);
        continue;
      }

      // === FILTRO STANDARD per film e serie tradizionali ===
      // Per le serie uso titleMatches permissivo (controlla solo che tutte le parole
      // significative del titolo siano nel torrent name). Lo strict-matcher che
      // avevo aggiunto per anti-spinoff (Law & Order SVU, NCIS Hawaii) finiva per
      // rigettare anche le release italiane (DLMux/MULTi/iSPA naming) — meglio
      // mostrare qualche spinoff in più che perdere tutti gli ITA.
      if (r.provider !== 'EZTV' && r.provider !== 'Nyaa') {
        if (!titleMatches(r.title, meta, { checkYear: effectiveType === 'movie' })) continue;
      }
      if (effectiveType === 'series' && meta.season && meta.episode) {
        // Accetta match esatto OPPURE season pack. I pack vengono marcati con
        // seasonPack=true così addon.js può:
        //  - per Torbox: filtrare via batch-check chi NON contiene file dell'episodio
        //  - per debrid resolve: chiamare /play con S/E e pickBestFile selezionerà
        //    il file giusto dentro il pack.
        const exact = matchesEpisode(r.title, meta.season, meta.episode);
        const pack = isSeasonPack(r.title, meta.season);
        if (r.provider !== 'EZTV' && !exact && !pack) continue;
        if (pack && !exact) r.seasonPack = true;
      }
      // Auto-tag SUB ITA per le serie quando non già marcato ITA né SUB ITA
      // ma il release name suggerisce sub italiani (lang-list con ita o source streaming).
      if (effectiveType === 'series' && !r.italian && !r.italianSub) {
        if (seriesProbablyHasItaSub(r.title)) r.italianSub = true;
      }
      out.push(r);
    }
  }

  // Tier di priorità per lingua scelta:
  //   IT (default): 1) audio ITA  2) sub ITA  3) resto
  //   EN (film/series): 1) audio ENG  2) sub ENG  3) resto
  //   EN anime: 1) audio ENG OR sub ENG (JP+sub-EN = standard mondiale anime)  2) resto
  // Dentro ogni tier: per qualità (4K > 1080p > 720p > 480p > CAM > ?), poi seeds.
  const QUALITY_RANK = { '4K': 5, '1080p': 4, '720p': 3, '480p': 2, CAM: 1 };
  const qrank = (q) => QUALITY_RANK[q] || 0;
  const tier = _lang === 'en'
    ? (effectiveType === 'anime'
        ? (r) => (r.english || r.englishSub) ? 0 : 1
        : (r) => r.english ? 0 : r.englishSub ? 1 : 2)
    : (r) => r.italian ? 0 : r.italianSub ? 1 : 2;
  out.sort((a, b) => {
    const td = tier(a) - tier(b);
    if (td !== 0) return td;
    const qd = qrank(b.quality) - qrank(a.quality);
    if (qd !== 0) return qd;
    return b.seeds - a.seeds;
  });
  return out;
}

// Distribuisce i risultati garantendo rappresentanza per ogni tier di qualità,
// ma SEMPRE includendo prima TUTTI gli ITA (audio + sub). Senza questa garanzia,
// in modalità debrid gli italiani si perdono perché i buckets-per-qualità tagliano
// e il batch-check vede solo i top non-ITA → risultati visibili in inglese.
function distributeByQuality(items, max) {
  const tiers = ['4K', '1080p', '720p', '480p', 'CAM'];
  const out = [];
  const inSet = new Set();
  function take(it) {
    if (inSet.has(it.infoHash)) return false;
    inSet.add(it.infoHash);
    out.push(it);
    return true;
  }

  // 1) PRIORITÀ ASSOLUTA: tutti gli ITA audio (fino a max)
  for (const it of items) {
    if (out.length >= max) break;
    if (it.italian) take(it);
  }
  // 2) Poi tutti i SUB ITA
  for (const it of items) {
    if (out.length >= max) break;
    if (it.italianSub) take(it);
  }
  // 3) Riempi con quality-distribution tra il resto
  const remaining = items.filter((it) => !inSet.has(it.infoHash));
  const buckets = new Map(tiers.map((t) => [t, []]));
  const unknown = [];
  for (const it of remaining) {
    if (buckets.has(it.quality)) buckets.get(it.quality).push(it);
    else unknown.push(it);
  }
  const slotsLeft = max - out.length;
  const perTier = Math.max(2, Math.ceil(slotsLeft / tiers.length));
  for (const t of tiers) {
    for (const it of buckets.get(t).slice(0, perTier)) {
      if (out.length >= max) break;
      take(it);
    }
  }
  for (const it of unknown) {
    if (out.length >= max) break;
    take(it);
  }
  // Top-up finale
  for (const it of items) {
    if (out.length >= max) break;
    take(it);
  }
  return out.slice(0, max);
}


module.exports = { searchTorrents, distributeByQuality };
