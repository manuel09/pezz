// Animepahe provider (anime HTTP EN sub/dub).
// Stesso pattern di AW/AS/AU/SC/VidXgo: scrape diretto, niente API esterne.
//
// Flusso:
//   1. Search:    GET /api?m=search&q={title}        → JSON {data:[{session, title, episodes}]}
//   2. Episodes:  GET /api?m=release&id={session}&sort=episode_asc&page=N
//                                                     → JSON {data:[{session, episode}]}
//   3. Play page: GET /play/{anime_session}/{ep_session}
//                                                     → HTML con <button data-src="https://kwik.cx/e/XXX" data-audio="eng|jpn" data-resolution="1080|720|360">
//   4. KWiK:      GET data-src                       → HTML con JS packed (Dean Edwards p.a.c.k.e.r)
//                                                     → unpack → estrai source m3u8
//
// Preferenza qualità: 1080p > 720p > 360p.
// Preferenza audio (lang='en'): dub eng > sub jpn.
//
// L'utente Cloudflare può richiedere DDoS-Guard cookie sul primo accesso.
// In quel caso aggiungiamo un retry con session cookie.

const fetch = require('node-fetch');

// Animepahe cambia TLD periodicamente per evadere DMCA. Dominio canonico
// 2026 = animepahe.pw (resolved via animepahe.com/animepahe.org redirect).
// Override via env ANIMEPAHE_HOST se cambia di nuovo.
const ANIMEPAHE_HOST = (process.env.ANIMEPAHE_HOST || 'https://animepahe.pw').replace(/\/$/, '');

// IMPORTANTE: 2026-06-01 verificato che animepahe.pw è dietro DDoS-Guard.
// Cycletls non basta per bypassare la challenge (response 403 con HTML JS
// challenge). Provider disabilitato di default. Per attivarlo in futuro
// (se DDoS-Guard viene rimosso o si trova bypass via proxy residenziale):
//   ENABLE_ANIMEPAHE=true npm start
const ENABLED = (process.env.ENABLE_ANIMEPAHE || '').toLowerCase() === 'true';

// Headers per evitare blocco generico (User-Agent + Referer animepahe).
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/json,*/*;q=0.9',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': `${ANIMEPAHE_HOST}/`,
};

// Cache risultati per (title, season, episode) — 30 min, riduce carico API.
const _cache = new Map();
const CACHE_TTL = 30 * 60 * 1000;
function _cacheGet(k) { const e = _cache.get(k); if (!e || Date.now() - e.t > CACHE_TTL) { _cache.delete(k); return null; } return e.v; }
function _cacheSet(k, v) { if (_cache.size >= 500) _cache.delete(_cache.keys().next().value); _cache.set(k, { v, t: Date.now() }); }

// Pulizia titolo: rimuove caratteri che animepahe non gradisce nelle query.
function _cleanTitle(s) {
  return String(s || '').replace(/['']/g, '').replace(/[:;]/g, ' ').replace(/[^\w\s\-]/g, ' ').replace(/\s+/g, ' ').trim();
}

async function _fetchText(url, timeoutMs = 6000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: HEADERS, signal: c.signal });
    if (!r.ok) return null;
    return await r.text();
  } catch (_) { return null; } finally { clearTimeout(t); }
}
async function _fetchJson(url, timeoutMs = 6000) {
  const text = await _fetchText(url, timeoutMs);
  if (!text) return null;
  try { return JSON.parse(text); } catch (_) { return null; }
}

// Dean Edwards p.a.c.k.e.r unpacker (versione pura, no eval).
// Pattern packed: eval(function(p,a,c,k,e,d){...}('STRING',NUM,NUM,'k1|k2|...'.split('|'),0,{}))
function _unpackJs(packed) {
  const m = packed.match(/}\s*\(\s*'((?:[^'\\]|\\.)*)'\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*'((?:[^'\\]|\\.)*)'\.split\('\|'\)/);
  if (!m) return null;
  const payload = m[1].replace(/\\'/g, "'").replace(/\\\\/g, '\\');
  const radix = parseInt(m[2], 10);
  const count = parseInt(m[3], 10);
  const keys = m[4].split('|');
  function toBaseN(n) {
    let s = '';
    while (n > 0) { const d = n % radix; s = (d < 10 ? String(d) : String.fromCharCode(d + 87)) + s; n = Math.floor(n / radix); }
    return s || '0';
  }
  let out = payload;
  for (let i = count - 1; i >= 0; i--) {
    const k = toBaseN(i);
    if (keys[i]) {
      out = out.replace(new RegExp('\\b' + k + '\\b', 'g'), keys[i]);
    }
  }
  return out;
}

// Estrae l'URL .m3u8 da una pagina KWiK player. La risposta di KWiK è un HTML
// con uno <script> contenente la versione packed del player JS, dentro cui c'è
// source = "https://....m3u8". Unpack + regex.
async function _kwikToM3u8(kwikUrl) {
  const html = await _fetchText(kwikUrl, 6000);
  if (!html) return null;
  const packedMatch = html.match(/<script>\s*(eval\(function\(p,a,c,k,e,d\)[^<]+)<\/script>/);
  if (!packedMatch) return null;
  const unpacked = _unpackJs(packedMatch[1]);
  if (!unpacked) return null;
  const m3u8 = unpacked.match(/https?:\/\/[^\s'"]+\.m3u8[^\s'"]*/);
  return m3u8 ? m3u8[0] : null;
}

// Public API: trova stream HLS per un anime episode in EN.
// Firma compatibile con altri provider HTTP (animeworld/animesaturn/animeunity).
async function findStreams(title, season, episode, absoluteEpisode, aliases, imdbId, providerSlugs) {
  if (!ENABLED) return []; // Provider OFF di default (DDoS-Guard upstream)
  const ep = episode || absoluteEpisode;
  if (!title || !ep) return [];

  const cleanT = _cleanTitle(title);
  const ckey = `ap:${cleanT}:${season || ''}:${ep}`;
  const cached = _cacheGet(ckey);
  if (cached) return cached;

  try {
    // 1. Search
    const searchData = await _fetchJson(`${ANIMEPAHE_HOST}/api?m=search&q=${encodeURIComponent(cleanT)}`, 5000);
    const results = searchData?.data || [];
    if (!results.length) return [];

    // Match: prima entry con titolo simile (animepahe ritorna già ranked).
    // Per stagioni >1 cerco match "Season X" / "Xnd Season" nel titolo.
    let anime = results[0];
    if (season && season > 1) {
      const want = String(season);
      const sCandidates = results.filter((r) => {
        const t = (r.title || '').toLowerCase();
        return t.includes(`season ${want}`) || t.includes(`${want}nd season`) || t.includes(`${want}rd season`) || t.includes(`${want}th season`);
      });
      if (sCandidates.length) anime = sCandidates[0];
    }
    if (!anime?.session) return [];

    // 2. Episodes (page 1, di solito basta)
    const epData = await _fetchJson(`${ANIMEPAHE_HOST}/api?m=release&id=${anime.session}&sort=episode_asc&page=1`, 5000);
    let episodes = epData?.data || [];
    // Se l'episodio non è in pagina 1, cerca nelle pagine successive
    const total = epData?.last_page || 1;
    let epObj = episodes.find((e) => Number(e.episode) === Number(ep));
    for (let page = 2; page <= total && !epObj; page++) {
      const more = await _fetchJson(`${ANIMEPAHE_HOST}/api?m=release&id=${anime.session}&sort=episode_asc&page=${page}`, 5000);
      const moreEps = more?.data || [];
      epObj = moreEps.find((e) => Number(e.episode) === Number(ep));
    }
    if (!epObj?.session) return [];

    // 3. Play page → estrai data-src KWiK + audio + resolution
    const playHtml = await _fetchText(`${ANIMEPAHE_HOST}/play/${anime.session}/${epObj.session}`, 6000);
    if (!playHtml) return [];

    // <button data-src="https://kwik.si/e/XXX" data-audio="eng" data-resolution="1080" ...>
    const buttonRe = /<button[^>]*data-src="([^"]+)"[^>]*data-audio="([^"]+)"[^>]*data-resolution="([^"]+)"/g;
    const variants = [];
    let bm;
    while ((bm = buttonRe.exec(playHtml)) !== null) {
      variants.push({ kwik: bm[1], audio: bm[2], resolution: parseInt(bm[3], 10) || 0 });
    }
    if (!variants.length) return [];

    // Preferenza: dub eng prima, sub jpn dopo. Quality 1080>720>360.
    variants.sort((a, b) => {
      const aDub = a.audio === 'eng' ? 1 : 0;
      const bDub = b.audio === 'eng' ? 1 : 0;
      if (aDub !== bDub) return bDub - aDub;
      return b.resolution - a.resolution;
    });
    const best = variants[0];

    // 4. KWiK unpack → URL m3u8
    const m3u8 = await _kwikToM3u8(best.kwik);
    if (!m3u8) return [];

    const out = [{
      provider: 'AP', // Animepahe
      url: m3u8,
      italian: false,
      italianSub: false,
      english: best.audio === 'eng',
      englishSub: best.audio !== 'eng',
      quality: best.resolution ? `${best.resolution}p` : null,
    }];
    _cacheSet(ckey, out);
    return out;
  } catch (e) {
    console.error('[Animepahe] findStreams err:', e.message);
    return [];
  }
}

module.exports = { findStreams };
