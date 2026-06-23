const fetch = require('node-fetch');

const LOONEX_DOMAIN = 'https://loonex.eu';

const PLAYBACK_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36',
  'Accept': '*/*',
  'Accept-Language': 'it-IT,it;q=0.9,en;q=0.8',
  'Referer': `${LOONEX_DOMAIN}/`,
  'Origin': LOONEX_DOMAIN,
};

const cache = new Map();
function cacheGet(k) {
  const e = cache.get(k);
  if (!e) return null;
  if (Date.now() - e.t > 10 * 60 * 1000) { cache.delete(k); return null; }
  return e.v;
}
function cacheSet(k, v) {
  if (cache.size >= 500) cache.delete(cache.keys().next().value);
  cache.set(k, { v, t: Date.now() });
}

function decryptUrl(hexStr, key) {
  let out = '';
  for (let i = 0; i < hexStr.length; i += 2) {
    const charCode = parseInt(hexStr.substr(i, 2), 16);
    out += String.fromCharCode(charCode ^ key.charCodeAt((i / 2) % key.length));
  }
  try { return decodeURIComponent(out); } catch (e) { return out; }
}

async function getVideoUrl(guardaId) {
  const ckey = `guarda:${guardaId}`;
  const cached = cacheGet(ckey);
  if (cached) return cached;

  const url = `${LOONEX_DOMAIN}/guarda/?id=${encodeURIComponent(guardaId)}`;
  const r = await fetch(url, {
    headers: {
      'User-Agent': PLAYBACK_HEADERS['User-Agent'],
      'Accept': 'text/html,*/*',
      'Accept-Language': PLAYBACK_HEADERS['Accept-Language'],
    },
    timeout: 10000,
  });
  if (!r.ok) throw new Error(`guarda page ${r.status}`);
  const html = await r.text();

  const encMatch = html.match(/encodedStr\s*=\s*"([^"]+)"/);
  const keyMatch = html.match(/decryptionKey\s*=\s*"([^"]+)"/);
  if (!encMatch || !keyMatch) throw new Error('cannot find encrypted URL in page');

  const videoUrl = decryptUrl(encMatch[1], keyMatch[1]);
  if (!videoUrl || !videoUrl.startsWith('http')) throw new Error(`invalid decrypted URL: ${videoUrl}`);

  cacheSet(ckey, videoUrl);
  return videoUrl;
}

async function searchCartoons(query) {
  const ckey = `search:${query.toLowerCase().trim()}`;
  const cached = cacheGet(ckey);
  if (cached) return cached;

  // Cerca su LooneX via form
  const r = await fetch(`${LOONEX_DOMAIN}/cartoni/index.php`, {
    headers: {
      'User-Agent': PLAYBACK_HEADERS['User-Agent'],
      'Accept': 'text/html,*/*',
    },
    timeout: 10000,
  });
  if (!r.ok) return [];
  const html = await r.text();

  const results = [];
  const cardRegex = /<a[^>]*href="[^"]*\?cartone=([^"&]+)[^"]*"[^>]*>[\s\S]*?<div[^>]*class="card-title-cine[^"]*"[^>]*>([^<]+)<\/div>/gi;
  let match;
  while ((match = cardRegex.exec(html)) !== null) {
    const slug = match[1].split('-').slice(0, -1).join('-'); // remove trailing timestamp
    const name = match[2].trim();
    if (name.toLowerCase().includes(query.toLowerCase())) {
      results.push({ slug: slug || match[1], name, fullSlug: match[1] });
    }
  }

  cacheSet(ckey, results);
  return results;
}

async function getCartoonEpisodes(slug) {
  const ckey = `episodes:${slug}`;
  const cached = cacheGet(ckey);
  if (cached) return cached;

  // Prova slug diretto prima
  let r = await fetch(`${LOONEX_DOMAIN}/cartoni/?cartone=${encodeURIComponent(slug)}`, {
    headers: {
      'User-Agent': PLAYBACK_HEADERS['User-Agent'],
      'Accept': 'text/html,*/*',
    },
    timeout: 10000,
    redirect: 'follow',
  });
  if (!r.ok) return [];
  const url = r.url;
  const html = await r.text();

  const episodes = [];
  // Extract guarda links: /guarda/?id=SLUG_SXEP
  const guardaRegex = /<a[^>]*href="[^"]*\/guarda\/\?id=([a-z0-9_-]+)"[^>]*>[\s\S]*?<\/a>/gi;
  let m;
  while ((m = guardaRegex.exec(html)) !== null) {
    const gid = m[1];
    const labelMatch = html.substring(Math.max(0, m.index - 200), m.index).match(/(Episodio\s*\d+|Film\s*Completo|[^<>]+)/i);
    if (!episodes.some(e => e.guardaId === gid)) {
      episodes.push({
        guardaId: gid,
        // Parse SxEE pattern
        season: gid.includes('x') ? parseInt(gid.split('x')[0].split('_').pop()) || 1 : null,
        episode: gid.includes('x') ? parseInt(gid.split('x')[1]) || null : null,
        isMovie: !gid.includes('x'),
        label: labelMatch ? labelMatch[1].trim() : gid,
      });
    }
  }

  cacheSet(ckey, episodes);
  return episodes;
}

async function findStream(imdbId, season, episode, isMovie) {
  // TOOD: IMDB → LooneX slug mapping
  return null;
}

module.exports = { findStream, getVideoUrl, searchCartoons, getCartoonEpisodes, decryptUrl };
