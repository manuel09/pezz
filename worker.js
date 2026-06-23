// Cloudflare Worker — reverse proxy per CinemaCity + Altadefinizione
// CinemaCity: proxy trasparente /path → https://cinemacity.cc/path
// ADN: /adn/api/:tmdbId/:type/:season?/:episode? → ADN API

const CC_UPSTREAM = 'https://cinemacity.cc';
const ADN_BASE = 'https://altadefinizionestreaming.com';
const UA = 'Mozilla/5.0';

async function handleAdnApi(url) {
  const pathParts = url.pathname.slice(1).split('/');
  // /adn/api/:tmdbId/:type(/:season?/:episode?)
  if (pathParts.length < 3 || pathParts[0] !== 'adn' || pathParts[1] !== 'api') return null;
  
  const tmdbId = pathParts[2];
  const type = pathParts[3]; // 'movie' or 'tv'
  const season = pathParts[4];
  const episode = pathParts[5];
  const isMovie = type === 'movie' || !season;
  
  const apiPath = isMovie
    ? `/api/player-sources/movie/${encodeURIComponent(tmdbId)}`
    : `/api/player-sources/tv/${encodeURIComponent(tmdbId)}/${season}/${episode}`;
  
  const apiUrl = ADN_BASE + apiPath;
  const resp = await fetch(apiUrl, {
    headers: {
      'User-Agent': UA,
      'Accept': 'application/json,text/plain,*/*',
      'Accept-Language': 'it-IT,it;q=0.9,en;q=0.8',
      'Referer': ADN_BASE + '/',
      'Cookie': 'sid=32234dfabd14e587764e84405e75e99856c6bef31c6b1752e19897b8ae3d4a21',
    },
  });
  
  const data = await resp.text();
  const respHeaders = new Headers();
  respHeaders.set('Content-Type', 'application/json');
  respHeaders.set('Access-Control-Allow-Origin', '*');
  
  return new Response(data, { status: resp.status, headers: respHeaders });
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const workerHost = url.host;
    
    // ADN API proxy
    if (url.pathname.startsWith('/adn/api/')) {
      return handleAdnApi(url) || new Response('adn api error', { status: 502 });
    }
    
    // CinemaCity proxy
    const targetUrl = CC_UPSTREAM + url.pathname + url.search;
    
    try {
      const upstream = await fetch(targetUrl, {
        method: request.method,
        headers: {
          'User-Agent': request.headers.get('User-Agent') || UA,
          'Accept': request.headers.get('Accept') || 'text/html,application/xhtml+xml',
          'Accept-Language': request.headers.get('Accept-Language') || 'it-IT,it;q=0.9,en;q=0.8',
          'Referer': request.headers.get('Referer') || CC_UPSTREAM + '/',
        },
        redirect: 'follow',
      });
      
      const contentType = upstream.headers.get('Content-Type') || '';
      let body = upstream.body;
      let respHeaders = new Headers(upstream.headers);
      respHeaders.set('Access-Control-Allow-Origin', '*');
      respHeaders.delete('Set-Cookie');
      respHeaders.delete('CF-Ray');
      respHeaders.delete('Server');
      
      if (contentType.includes('text/html')) {
        let html = await upstream.text();
        html = html.replace(/https?:\/\/cinemacity\.cc/g, 'https://' + workerHost);
        html = html.replace(/cinemacity\.cc/g, workerHost);
        respHeaders.delete('Content-Length');
        respHeaders.delete('Content-Encoding');
        return new Response(html, { status: upstream.status, headers: respHeaders });
      }
      
      return new Response(body, { status: upstream.status, headers: respHeaders });
    } catch (e) {
      return new Response('proxy error: ' + e.message, { status: 502 });
    }
  },
};
