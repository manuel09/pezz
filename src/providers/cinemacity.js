// CinemaCity provider.
// Port from StreamVix (qwertyuiop8899/streamvix) direct mode.
// Fetches cinemacity.cc via Cloudflare Worker, finds the title by sitemap
// matching, extracts direct HLS/CDN URL from the page.

const fetch = require('node-fetch');

const BASE_URL = 'https://cinemacity.cc';
const SITEMAP_PATH = '/news_pages.xml';
const SITEMAP_PAGE_SIZE = 500;
const SITEMAP_TTL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10000;

const UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';
const WORKER_HOST = Buffer.from('Y2MubGVhbmhodTA2MTIwNi53b3JrZXJzLmRldg==', 'base64').toString('utf-8');

const PLAYBACK_HEADERS = {
  'User-Agent': UA,
  'Accept': '*/*',
  'Accept-Language': 'it-IT,it;q=0.9,en;q=0.8',
  'Referer': `${BASE_URL}/`,
  'Origin': BASE_URL,
};

function logC(...args) { try { console.log('[CinemaCity]', ...args); } catch {} }

let sitemapCache = null;

function normalizeTitle(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
function compactTitle(value) { return normalizeTitle(value).replace(/\s+/g, ''); }

const STOPWORDS = new Set([
  'the','a','an','of','and','in','on','to','for','at','by','is','it',
  'il','lo','la','gli','le','un','uno','una','di','da','del','della','dei',
  'e','o','con','per','su','tra','fra',
]);

function getSignificantTokens(value) {
  return normalizeTitle(value).split(/\s+/).filter(t => t.length > 1 && !STOPWORDS.has(t));
}

function parseSitemapEntries(xml) {
  const entries = [];
  const re = /<loc>(https:\/\/cinemacity\.cc\/(movies|tv-series)\/\d+-([a-z0-9-]+)\.html)<\/loc>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const url = m[1];
    const kind = m[2];
    const slug = m[3];
    const yearMatch = slug.match(/-(\d{4})$/);
    const year = yearMatch ? parseInt(yearMatch[1], 10) : null;
    const titleSlug = yearMatch ? slug.slice(0, -5) : slug;
    const title = titleSlug.replace(/-/g, ' ');
    entries.push({
      url, kind, title, year: Number.isInteger(year) ? year : null,
      normalizedTitle: normalizeTitle(title),
      compactTitle: compactTitle(title),
      tokens: getSignificantTokens(title),
    });
  }
  return entries;
}

function workerUrl(pathAndQuery) {
  const p = pathAndQuery.startsWith('/') ? pathAndQuery : '/' + pathAndQuery;
  return `https://${WORKER_HOST}${p}`;
}

async function fetchViaWorker(absoluteOrPath, extraHeaders = {}) {
  let pathAndQuery;
  if (/^https?:\/\//i.test(absoluteOrPath)) {
    try {
      const u = new URL(absoluteOrPath);
      pathAndQuery = u.pathname + u.search;
    } catch { return null; }
  } else {
    pathAndQuery = absoluteOrPath;
  }
  const target = workerUrl(pathAndQuery);
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(target, {
      headers: { 'User-Agent': UA, ...extraHeaders },
      signal: ctl.signal,
    });
    const text = await r.text();
    return { status: r.status, text, headers: r.headers };
  } catch (e) {
    return null;
  } finally { clearTimeout(t); }
}

async function fetchSitemap() {
  if (sitemapCache && sitemapCache.expiresAt > Date.now()) return sitemapCache.entries;
  logC('fetching paginated sitemap via worker');
  let all = [];
  const first = await fetchViaWorker(`${SITEMAP_PATH}?page=1&perPage=${SITEMAP_PAGE_SIZE}`);
  if (first && first.status >= 200 && first.status < 400) {
    all = parseSitemapEntries(first.text);
    const total = parseInt(first.headers.get('x-total-entries') || '0', 10);
    if (Number.isInteger(total) && total > all.length) {
      const totalPages = Math.ceil(total / SITEMAP_PAGE_SIZE);
      const tasks = [];
      for (let p = 2; p <= totalPages; p++) {
        tasks.push((async () => {
          const r = await fetchViaWorker(`${SITEMAP_PATH}?page=${p}&perPage=${SITEMAP_PAGE_SIZE}`);
          if (r && r.status >= 200 && r.status < 400) {
            all = all.concat(parseSitemapEntries(r.text));
          }
        })());
      }
      await Promise.all(tasks);
    }
  }
  if (all.length === 0) {
    const r = await fetchViaWorker(SITEMAP_PATH);
    if (r && r.status >= 200 && r.status < 400) all = parseSitemapEntries(r.text);
  }
  if (all.length === 0) throw new Error('sitemap empty');
  sitemapCache = { entries: all, expiresAt: Date.now() + SITEMAP_TTL_MS };
  logC('sitemap loaded:', all.length, 'entries');
  return all;
}

async function getTmdbMetadata(id, isMovie, apiKey) {
  try {
    const normId = id.trim();
    const kind = isMovie ? 'movie' : 'tv';
    let url;
    if (/^tt\d+$/i.test(normId)) {
      url = `https://api.themoviedb.org/3/find/${encodeURIComponent(normId)}?api_key=${apiKey}&external_source=imdb_id&language=en-US`;
    } else if (/^\d+$/.test(normId)) {
      url = `https://api.themoviedb.org/3/${kind}/${normId}?api_key=${apiKey}&language=en-US`;
    } else return null;
    const r = await fetch(url, { timeout: FETCH_TIMEOUT_MS });
    if (!r.ok) return null;
    const j = await r.json();
    if (/^tt\d+$/i.test(normId)) {
      const arr = isMovie ? j.movie_results : j.tv_results;
      return Array.isArray(arr) && arr.length ? arr[0] : null;
    }
    return j;
  } catch { return null; }
}

function extractYear(meta) {
  const d = (meta && (meta.release_date || meta.first_air_date)) || '';
  const y = parseInt(String(d).slice(0, 4), 10);
  return Number.isInteger(y) ? y : null;
}

function scoreEntry(entry, expectedTitles, expectedYear) {
  let best = 0;
  for (const title of expectedTitles) {
    const norm = normalizeTitle(title);
    const comp = compactTitle(title);
    if (!norm || !comp) continue;
    let score = 0;
    if (entry.normalizedTitle === norm || entry.compactTitle === comp) score = 1000;
    else if (entry.normalizedTitle.startsWith(norm) || norm.startsWith(entry.normalizedTitle)) score = 500;
    else {
      const exp = getSignificantTokens(title);
      if (exp.length && entry.tokens.length) {
        let hits = 0;
        const set = new Set(entry.tokens);
        for (const t of exp) if (set.has(t)) hits++;
        score = (hits / exp.length) * 300 - Math.max(0, entry.tokens.length - exp.length) * 20 - Math.abs(entry.tokens.length - exp.length) * 2;
      }
    }
    if (expectedYear && entry.year) {
      score += entry.year === expectedYear ? 50 : -Math.abs(entry.year - expectedYear) * 3;
    }
    if (score > best) best = score;
  }
  return best;
}

async function verifyImdbOnPage(url, expectedImdb) {
  const r = await fetchViaWorker(url, {
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
    'Referer': `${BASE_URL}/`,
  });
  if (!r || r.status < 200 || r.status >= 400) return false;
  const m = (r.text.match(/\btt\d{5,}\b/gi) || [])[0];
  return !!m && m.toLowerCase() === expectedImdb.toLowerCase();
}

async function searchBySitemap(imdbId, isMovie, apiKey) {
  const expectedImdb = /^tt\d{5,}$/i.test(imdbId) ? imdbId.toLowerCase() : null;
  const meta = await getTmdbMetadata(imdbId, isMovie, apiKey);
  const expectedTitles = Array.from(new Set([
    meta && meta.title, meta && meta.name, meta && meta.original_title, meta && meta.original_name,
  ].filter(Boolean)));
  if (!expectedTitles.length) { logC('no TMDB titles for', imdbId); return null; }
  const year = extractYear(meta);
  const expectedKind = isMovie ? 'movies' : 'tv-series';
  let entries;
  try { entries = await fetchSitemap(); } catch (e) { logC('sitemap err', e.message); return null; }

  let best = null;
  let bestScore = -Infinity;
  const ranked = [];
  for (const e of entries) {
    if (e.kind !== expectedKind) continue;
    const s = scoreEntry(e, expectedTitles, year);
    if (s >= 250) ranked.push({ entry: e, score: s });
    if (s > bestScore) { bestScore = s; best = e; }
  }
  if (!best || bestScore < 250) {
    logC('no confident match for', expectedTitles[0], 'best=', Math.round(bestScore));
    return null;
  }
  if (expectedImdb) {
    ranked.sort((a, b) => b.score - a.score);
    for (const c of ranked.slice(0, 3)) {
      if (await verifyImdbOnPage(c.entry.url, expectedImdb)) {
        logC('IMDb verified:', expectedTitles[0], '->', c.entry.url);
        return { url: c.entry.url, title: expectedTitles[0] || c.entry.title };
      }
    }
    if (bestScore < 950) {
      logC('match not IMDb-verified, skipping (best', Math.round(bestScore), ')');
      return null;
    }
  }
  logC('match:', expectedTitles[0], '->', best.url, 'score=' + Math.round(bestScore));
  return { url: best.url, title: expectedTitles[0] || best.title };
}

function buildDownloadUrl(fileVal) {
  const idx = fileVal.indexOf('/public_files/');
  if (idx === -1) return null;
  const cdnBase = fileVal.substring(0, idx + '/public_files/'.length);
  const rest = fileVal.substring(idx + '/public_files/'.length);
  const parts = rest.split(',');
  const video = parts.find(p => p.includes('1080p') && p.endsWith('.mp4')) || parts.find(p => p.endsWith('.mp4'));
  const itaAudio = parts.find(p => /italian|italiano/i.test(p) && p.endsWith('.m4a'));
  if (!itaAudio || !video) return null;
  const m3u8Entry = parts.find(p => p.includes('.m3u8'));
  return cdnBase + rest + (m3u8Entry ? '' : '.urlset/master.m3u8');
}

function extractStreamFromAtob(html, season, episode) {
  const re = /atob\s*\(\s*['"]([^"']{20,})['"]\s*\)/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    let decoded;
    try { decoded = Buffer.from(m[1], 'base64').toString('utf-8'); } catch { continue; }
    if (!decoded) continue;
    const jm = decoded.match(/file\s*:\s*'(\[.*?\])'/s);
    if (!jm) continue;
    try {
      const parsed = JSON.parse(jm[1]);
      if (!Array.isArray(parsed) || parsed.length === 0) continue;
      if (parsed[0] && parsed[0].folder && Array.isArray(parsed[0].folder)) {
        const sIdx = Math.max(0, (season || 1) - 1);
        const s = parsed[sIdx];
        const eIdx = Math.max(0, (episode || 1) - 1);
        const ep = s && s.folder && s.folder[eIdx];
        if (ep && ep.file) return buildDownloadUrl(ep.file) || ep.file;
      }
      const fileVal = parsed[0] && parsed[0].file;
      if (typeof fileVal === 'string' && fileVal.startsWith('http')) {
        return buildDownloadUrl(fileVal) || fileVal;
      }
    } catch { /* keep scanning */ }
  }
  return null;
}

function extractDownloadLinks(html) {
  const out = [];
  const re = /<a\s[^>]*href=["']([^"']+)["'][^>]*>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const href = m[1].trim();
    if (!/\.(mp4|m3u8|mkv|avi|mov|webm)([?#].*)?$/i.test(href)) continue;
    if (href.length < 10) continue;
    out.push({ url: href });
  }
  return out;
}

async function extractDirectStream(pageUrl, isMovie, season, episode) {
  const r = await fetchViaWorker(pageUrl, {
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
    'Referer': `${BASE_URL}/`,
  });
  if (!r || r.status < 200 || r.status >= 400) {
    logC('direct extract: page status', r && r.status);
    return null;
  }
  const html = r.text;
  if (html.length < 500) { logC('direct extract: page too small'); return null; }

  let picked = null;
  const anchors = extractDownloadLinks(html);
  if (anchors.length > 0) picked = anchors[0].url;
  if (!picked) picked = extractStreamFromAtob(html, isMovie ? null : season, isMovie ? null : episode);
  if (!picked) { logC('direct extract: no playable url'); return null; }
  if (/^https?:\/\//i.test(picked)) return picked;
  try { return new URL(picked, pageUrl).toString(); } catch { return null; }
}

async function findStream(imdbId, season, episode, isMovie) {
  if (!imdbId || !imdbId.startsWith('tt')) return null;
  const apiKey = process.env.TMDB_API_KEY || '4ef0d7355d9ffb5151e987764708ce96';
  try {
    const found = await searchBySitemap(imdbId, isMovie, apiKey);
    if (!found) return null;
    const directUrl = await extractDirectStream(found.url, isMovie, season || null, episode || null);
    if (!directUrl) return null;
    return {
      provider: 'CC',
      imdbId,
      season: season || null,
      episode: episode || null,
      isMovie: !!isMovie,
      masterUrl: directUrl,
      cdnHeaders: { ...PLAYBACK_HEADERS },
    };
  } catch (e) {
    logC('findStream err:', e.message);
    return null;
  }
}

function clearCaches() {
  sitemapCache = null;
}

module.exports = { findStream, clearCaches };
