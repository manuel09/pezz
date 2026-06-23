const fetch = require('node-fetch');

const VD_DOMAIN = (process.env.VIDXGO_DOMAIN || 'https://v.vidxgo.co').replace(/\/+$/, '');

const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:150.0) Gecko/20100101 Firefox/150.0',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
  'Referer': 'https://altadefinizione.you/',
  'DNT': '1',
  'Sec-GPC': '1',
  'Connection': 'keep-alive',
  'Upgrade-Insecure-Requests': '1',
};

const PLAYBACK_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/139.0.0.0',
  'Accept': '*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': `${VD_DOMAIN}/`,
  'Origin': VD_DOMAIN,
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

const masterCache = new Map();

async function getMasterUrl(numericId, season, episode, isMovie) {
  const path = isMovie ? numericId : `${numericId}/${season}/${episode}`;
  const res = await fetch(`${VD_DOMAIN}/t/${path}`, {
    headers: {
      'User-Agent': FETCH_HEADERS['User-Agent'],
      'Accept': '*/*',
      'Referer': `${VD_DOMAIN}/${path}`,
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin',
    },
    timeout: 8000,
  });
  if (!res.ok) throw new Error(`/t/ -> ${res.status}`);
  const data = await res.json();
  if (!data || !data.url) throw new Error('no url in /t/ response');
  let masterUrl = data.url;
  if (!/[?&]h=1\b/.test(masterUrl)) {
    masterUrl += (masterUrl.includes('?') ? '&' : '?') + 'h=1';
  }
  return { url: masterUrl, expire: data.expire || (Date.now() + 4 * 60 * 1000) };
}

function buildUrl(imdbId, season, episode, isMovie) {
  const id = (imdbId || '').split(':')[0].replace('tt', '');
  if (isMovie || !season || !episode) return `${VD_DOMAIN}/${id}`;
  return `${VD_DOMAIN}/${id}/${season}/${episode}`;
}

async function getMasterUrlCached(numericId, season, episode, isMovie) {
  const k = `${numericId}:${season || ''}:${episode || ''}`;
  const entry = masterCache.get(k);
  if (entry && entry.expire - Date.now() > 60_000) return entry;
  const fresh = await getMasterUrl(numericId, season, episode, isMovie);
  masterCache.set(k, fresh);
  return fresh;
}

function cdnFetch(url, extraHeaders = {}) {
  return fetch(url, {
    headers: { ...PLAYBACK_HEADERS, ...extraHeaders },
    timeout: 10000,
    redirect: 'follow',
  });
}

async function findStream(imdbId, season, episode, isMovie) {
  if (!imdbId || !imdbId.startsWith('tt')) return null;

  const numericId = imdbId.replace('tt', '');
  const path = isMovie ? numericId : `${numericId}/${season}/${episode}`;

  try {
    const probe = await fetch(`${VD_DOMAIN}/${path}`, {
      headers: FETCH_HEADERS,
      timeout: 8000,
      redirect: 'follow',
    });
    if (!probe.ok && probe.status !== 403) return null;

    const master = await getMasterUrl(numericId, season, episode, isMovie);
    if (!master.url) return null;

    return {
      provider: 'VX',
      numericId,
      season: season || null,
      episode: episode || null,
      isMovie: !!isMovie,
      masterUrl: master.url,
      cdnHeaders: { ...PLAYBACK_HEADERS },
    };
  } catch (e) {
    return null;
  }
}

async function resolveSegmentUrl(numericId, season, episode, isMovie, segmentPath) {
  const master = await getMasterUrlCached(numericId, season, episode, isMovie);
  const r = await cdnFetch(master.url);
  if (!r.ok) throw new Error(`master CDN ${r.status}`);
  const masterText = await r.text();
  const baseUrl = master.url.replace(/[^\/]+\?.*$/, '');
  const playlistLines = masterText.split('\n').filter((l) => l && !l.startsWith('#'));
  for (const line of playlistLines) {
    const playlistUrl = line.startsWith('http') ? line : baseUrl + line;
    const pr = await cdnFetch(playlistUrl);
    if (!pr.ok) continue;
    const ptext = await pr.text();
    const segs = ptext.split('\n').filter((l) => l && !l.startsWith('#'));
    for (const s of segs) {
      const segUrl = s.startsWith('http') ? s : new URL(s, playlistUrl).toString();
      if (segUrl.includes(segmentPath) || segUrl.split('?')[0].endsWith(segmentPath)) {
        return segUrl;
      }
    }
  }
  return null;
}

function clearCaches() {
  const s = masterCache.size;
  masterCache.clear();
  return s;
}

module.exports = { findStream, getMasterUrlCached, cdnFetch, resolveSegmentUrl, clearCaches };
