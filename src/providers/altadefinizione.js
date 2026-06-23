// Altadefinizione provider.
// API via Cloudflare Worker per bypassare blocchi IP.
// Worker: /adn/api/:tmdbId/:type[/:season/:episode] → ADN API

const { proxyFetch, WARP_ENABLED } = require('../proxy');
const fetch = require('node-fetch');

const TMDB_API = 'https://api.themoviedb.org/3';
const TMDB_KEY = process.env.TMDB_API_KEY || '4ef0d7355d9ffb5151e987764708ce96';
const WORKER_HOST = 'holy-base-de5f.manu-17.workers.dev';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

function getCookie() {
  return process.env.ALTADEFINIZIONE_COOKIE || 'sid=32234dfabd14e587764e84405e75e99856c6bef31c6b1752e19897b8ae3d4a21';
}

const ADN_BASE = 'https://altadefinizionestreaming.com';

async function fetchAdnApiWorker(tmdbId, season, episode, isMovie) {
  let path = `/adn/api/${tmdbId}/${isMovie ? 'movie' : 'tv'}`;
  if (!isMovie) path += `/${season}/${episode}`;
  const url = `https://${WORKER_HOST}${path}`;
  
  const res = await fetch(url, { timeout: 15000 }).catch(e => { console.error('[ADN] worker error:', e.message); return null; });
  if (!res || !res.ok) { console.error('[ADN] worker status:', res?.status); return null; }
  const data = await res.json().catch(() => null);
  if (!data || data.unavailable) { console.error('[ADN] unavailable'); return null; }
  return data;
}

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

async function getCdnUrl(tmdbId, season, episode, isMovie) {
  const data = await fetchAdnApiWorker(tmdbId, season, episode, isMovie);
  if (!data) return null;
  console.log('[ADN] sources count:', data.sources?.length);
  const cdnSource = (data.sources || []).find((s) => s.provider === 'cdn');
  if (!cdnSource || !cdnSource.url) {
    console.error('[ADN] no cdn source, providers:', data.sources?.map(s => s.provider).join(','));
    return null;
  }
  return {
    url: cdnSource.url,
    quality: cdnSource.quality || '720p',
  };
}

async function findStream(imdbId, season, episode, isMovie) {
  if (!imdbId || !imdbId.startsWith('tt')) return null;
  try {
    const tmdbId = await imdbToTmdb(imdbId, isMovie ? 'movie' : 'tv');
    if (!tmdbId) return null;
    const cdn = await getCdnUrl(tmdbId, season, episode, isMovie);
    if (!cdn) return null;
    return {
      provider: 'ADN',
      tmdbId,
      season: season || null,
      episode: episode || null,
      isMovie: !!isMovie,
      cdnUrl: cdn.url,
      quality: cdn.quality,
    };
  } catch (e) {
    console.error('[ADN]', e.message);
    return null;
  }
}

async function getCdnUrlCached(tmdbId, season, episode, isMovie) {
  return getCdnUrl(tmdbId, season, episode, isMovie);
}

module.exports = { findStream, getCdnUrlCached };
