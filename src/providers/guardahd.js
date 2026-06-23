// GuardaHD provider.
// Scrapa mostraguarda.stream per embed video (vixcloud.co, supervideo.cc, ecc.).
// Solo film.
//
// Flusso:
//   1. GET https://mostraguarda.stream/movie/{imdb} → HTML
//   2. Estrae TUTTI i data-link dal DOM
//   3. Per vixcloud: fetch embed → masterPlaylist come prima
//   4. Per supervideo: unpack packed JS → estrae M3U8
//   5. Ritorna URL master playlist con proxyHeaders

const fetch = require('node-fetch');

const MG_DOMAIN = 'https://mostraguarda.stream';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

const COMMON_HEADERS = {
  'User-Agent': UA,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'it-IT,it;q=0.9,en;q=0.8',
};

const VIX_PLAYBACK_HEADERS = {
  'User-Agent': UA,
  'Accept': '*/*',
  'Accept-Language': 'it-IT,it;q=0.9,en;q=0.8',
  'Referer': 'https://vixcloud.co/',
  'Origin': 'https://vixcloud.co',
};

const SV_PLAYBACK_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  'Accept': '*/*',
  'Accept-Language': 'it-IT,it;q=0.9,en;q=0.8',
  'Referer': 'https://supervideo.tv/',
  'Origin': 'https://supervideo.tv',
};

// Dean Edwards packer unpacker
function unPack(p, a, c, k, e, d) {
  e = function (c2) {
    return (c2 < a ? '' : e(parseInt(String(c2 / a)))) + ((c2 = c2 % a) > 35 ? String.fromCharCode(c2 + 29) : c2.toString(36));
  };
  if (!''.replace(/^/, String)) {
    while (c--) { d[e(c)] = k[c] || e(c); }
    k = [function (e2) { return d[e2] || e2; }];
    e = function () { return '\\w+'; };
    c = 1;
  }
  while (c--) { if (k[c]) p = p.replace(new RegExp('\\b' + e(c) + '\\b', 'g'), k[c]); }
  return p;
}

// Proxy agent
let socksAgent;
function getSocksAgent() {
  if (socksAgent) return socksAgent;
  try {
    const SocksProxyAgent = require('socks-proxy-agent').SocksProxyAgent;
    socksAgent = new SocksProxyAgent('socks5://127.0.0.1:1080');
  } catch { socksAgent = null; }
  return socksAgent;
}

async function fetchViaSocks(url, headers) {
  const agent = getSocksAgent();
  if (!agent) { log('WARP SOCKS5 agent not available'); return null; }
  try {
    const r = await fetch(url, { agent, headers, timeout: 10000 });
    if (!r.ok) return null;
    const text = await r.text();
    return text;
  } catch { return null; }
}

// Estrae TUTTI i data-link da mostraguarda per un imdbId
const scrapeCache = new Map();
function log(...args) { try { console.log('[GH]', ...args); } catch {} }

async function scrapeAllEmbedUrls(imdbId) {
  const hit = scrapeCache.get(imdbId);
  if (hit && Date.now() - hit.t < 12 * 60 * 60 * 1000) return hit.v;
  const r = await fetch(`${MG_DOMAIN}/movie/${encodeURIComponent(imdbId)}`, {
    headers: COMMON_HEADERS, timeout: 8000,
  });
  if (!r.ok) { log('mostraguarda status', r.status); return null; }
  const html = await r.text();
  const re = /data-link="([^"]+)"/gi;
  const embeds = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    let url = m[1].trim();
    if (url.startsWith('//')) url = 'https:' + url;
    if (/^https?:\/\//i.test(url)) embeds.push(url);
  }
  const unique = [...new Set(embeds)];
  log('found', unique.length, 'embeds:', unique.map(u => u.replace(/\?.*$/, '').substring(0, 60)).join(', '));
  scrapeCache.set(imdbId, { v: unique, t: Date.now() });
  return unique;
}

// Estrae master playlist da embed vixcloud.co
async function extractVixCloud(embedUrl) {
  const r = await fetch(embedUrl, {
    headers: { ...COMMON_HEADERS, 'Referer': 'https://vixsrc.to/' },
    timeout: 8000,
  });
  if (!r.ok) throw new Error(`vixcloud embed ${r.status}`);
  const html = await r.text();
  const tokenM = html.match(/['"]token['"]\s*:\s*['"]([^'"]+)['"]/);
  const expiresM = html.match(/['"]expires['"]\s*:\s*['"]([^'"]+)['"]/);
  const urlM = html.match(/window\.masterPlaylist\s*=[\s\S]*?url\s*:\s*['"]([^'"]+)['"]/);
  if (!tokenM || !expiresM || !urlM) throw new Error('gh: masterPlaylist parse failed');
  const fhdM = html.match(/window\.canPlayFHD\s*=\s*(true|false)/);
  const fhd = fhdM ? fhdM[1] === 'true' : true;
  const sep = urlM[1].includes('?') ? '&' : '?';
  const masterUrl = `${urlM[1]}${sep}token=${tokenM[1]}&expires=${expiresM[1]}${fhd ? '&h=1' : ''}`;
  return {
    url: masterUrl,
    cdnHeaders: { ...VIX_PLAYBACK_HEADERS },
  };
}

// Estrae M3U8 da supervideo embed via packed JS unpack
async function extractSuperVideo(embedUrl) {
  const id = embedUrl.split('/').pop();
  const targetUrl = `https://supervideo.tv/e/${id}`;
  log('extractSuperVideo', targetUrl);

  let html = null;

  // Prova fetch diretta
  try {
    const r = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
        'Referer': 'https://supervideo.tv/',
      },
      timeout: 8000,
    });
    log('supervideo direct status:', r.status);
    if (r.ok) {
      const text = await r.text();
      if (text.includes('eval(function(p,a,c,k,e,d)')) { html = text; log('supervideo direct OK with packed JS'); }
      else log('supervideo direct OK but no packed JS, len:', text.length, 'has CF:', text.includes('Just a moment'));
    }
  } catch (e) { log('supervideo direct error:', e.message); }

  // Se bloccato (403/CF), prova via WARP SOCKS5
  if (!html) {
    log('trying supervideo via WARP SOCKS5...');
    html = await fetchViaSocks(targetUrl, {
      'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
      'Referer': 'https://supervideo.tv/',
    });
    if (html) log('supervideo WARP OK, len:', html.length, 'has packed:', html.includes('eval(function(p,a,c,k,e,d)'));
    else log('supervideo WARP failed');
  }

  if (!html) return null;

  // Trova packed JS
  const packedRe = /eval\(function\(p,a,c,k,e,d\).*\}\)\('/;
  const packedMatch = html.match(packedRe);
  if (!packedMatch) { log('no packed JS found in supervideo response'); return null; }

  // Unpack
  const pMatch = html.match(/eval\(function\(p,a,c,k,e,d\)\{.*?\}\('(.*?)',(\d+),(\d+),'(.*?)'\.split\('\|'\)/);
  if (!pMatch) { log('packed regex failed to extract parts'); return null; }

  const unpacked = unPack(pMatch[1], parseInt(pMatch[2]), parseInt(pMatch[3]), pMatch[4].split('|'), null, {});
  const fileMatch = unpacked.match(/sources:\[\{file:"(.*?)"/);
  if (!fileMatch) { log('unpacked but no sources found'); return null; }

  let m3u8 = fileMatch[1];
  if (m3u8.startsWith('//')) m3u8 = 'https:' + m3u8;

  log('supervideo M3U8 extracted:', m3u8.substring(0, 80));
  return {
    url: m3u8,
    cdnHeaders: { ...SV_PLAYBACK_HEADERS },
  };
}

async function findStream(imdbId, season, episode, isMovie) {
  if (!imdbId || !imdbId.startsWith('tt')) { log('findStream: invalid imdbId', imdbId); return null; }
  if (!isMovie) { log('findStream: not a movie', imdbId); return null; }
  log('findStream:', imdbId);
  try {
    const allUrls = await scrapeAllEmbedUrls(imdbId);
    if (!allUrls || !allUrls.length) { log('no embeds found for', imdbId); return null; }

    for (const url of allUrls) {
      try {
        if (/vixcloud\.co/i.test(url)) {
          log('trying vixcloud:', url.substring(0, 60));
          const result = await extractVixCloud(url);
          if (result) { log('vixcloud SUCCESS'); return { provider: 'GH', imdbId, isMovie: true, masterUrl: result.url, cdnHeaders: result.cdnHeaders }; }
        }
        if (/supervideo/i.test(url)) {
          log('trying supervideo:', url.substring(0, 60));
          const result = await extractSuperVideo(url);
          if (result) { log('supervideo SUCCESS'); return { provider: 'GH', imdbId, isMovie: true, masterUrl: result.url, cdnHeaders: result.cdnHeaders }; }
        }
      } catch (e) { log('embed error:', e.message); }
    }
    log('all embeds exhausted for', imdbId);
    return null;
  } catch (e) {
    log('findStream error:', e.message);
    return null;
  }
}

// Backward compat per index.js HLS proxy routes
async function getMasterUrlCached(imdbId, season, episode, isMovie) {
  const r = await findStream(imdbId, season, episode, isMovie);
  if (!r) throw new Error('gh: no stream');
  return { url: r.masterUrl, expire: Date.now() + 300_000 };
}
async function cdnFetch(url, extraHeaders = {}) {
  return fetch(url, { headers: { ...VIX_PLAYBACK_HEADERS, ...extraHeaders }, timeout: 10000, redirect: 'follow' });
}

module.exports = { findStream, getMasterUrlCached, cdnFetch };
