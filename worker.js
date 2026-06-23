// Cloudflare Worker — SC_PROXY reverse proxy
// Relay richieste a vixsrc.to, altadefinizionestreaming.com, mostraguarda.stream
// per bypassare blocchi CF "I'm Under Attack" da IP datacenter.
//
// Formato: GET /<host>/<path> → https://<host>/<path>
// Esempio: GET /vixsrc.to/api/movie/27205 → https://vixsrc.to/api/movie/27205

function viaProxy(url, proxyBase) {
  if (!proxyBase) return url;
  const m = url.match(/^https?:\/\/([^/]+)(\/.*)?$/);
  if (!m) return url;
  return `${proxyBase}/${m[1]}${m[2] || '/'}`;
}

async function handleAdnStream(request, url) {
  const pathParts = url.pathname.slice(1).split('/');
  // /adn/stream/:tmdbId/:type(/:season?/:episode?)
  if (pathParts.length < 3 || pathParts[0] !== 'adn' || pathParts[1] !== 'stream') {
    return null;
  }
  const tmdbId = pathParts[2];
  const type = pathParts[3] || 'movie'; // 'movie' or 'tv'
  const season = pathParts[4] ? Number(pathParts[4]) : null;
  const episode = pathParts[5] ? Number(pathParts[5]) : null;
  const isMovie = type === 'movie' || season === null;

  const ADN_BASE = 'https://altadefinizionestreaming.com';
  const apiPath = isMovie
    ? `/api/player-sources/movie/${encodeURIComponent(tmdbId)}`
    : `/api/player-sources/tv/${encodeURIComponent(tmdbId)}/${season}/${episode}`;

  const apiUrl = `${ADN_BASE}${apiPath}`;
  const apiResp = await fetch(apiUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Accept': 'application/json,text/plain,*/*',
      'Accept-Language': 'it-IT,it;q=0.9,en;q=0.8',
      'Referer': `${ADN_BASE}/`,
    },
    redirect: 'manual',
  });
  if (!apiResp.ok) {
    return new Response(`adn api error: ${apiResp.status}`, { status: 502 });
  }
  const data = await apiResp.json();
  if (!data || data.unavailable) {
    return new Response('adn: unavailable', { status: 502 });
  }
  const cdnSource = (data.sources || []).find((s) => s.provider === 'cdn');
  if (!cdnSource || !cdnSource.url) {
    return new Response('adn: no cdn source', { status: 502 });
  }

  const range = request.headers.get('Range') || '';
  const cdnHeaders = {
    'User-Agent': 'Mozilla/5.0',
  };
  if (range) cdnHeaders['Range'] = range;

  const cdnResp = await fetch(cdnSource.url, {
    headers: cdnHeaders,
    redirect: 'follow',
  });

  const respHeaders = new Headers(cdnResp.headers);
  respHeaders.delete('Set-Cookie');
  respHeaders.delete('CF-Ray');
  respHeaders.delete('Server');

  return new Response(cdnResp.body, {
    status: cdnResp.status,
    headers: respHeaders,
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Route /adn/stream/* → stream ADN (API + CDN in stessa richiesta)
    if (url.pathname.startsWith('/adn/stream/')) {
      try {
        return await handleAdnStream(request, url);
      } catch (e) {
        return new Response('adn stream error: ' + e.message, { status: 502 });
      }
    }

    // Generic SC_PROXY relay
    const pathParts = url.pathname.slice(1).split('/');
    const host = pathParts[0];
    const rest = '/' + pathParts.slice(1).join('/');

    if (!host || !rest) {
      return new Response('SC_PROXY: usa /<host>/<path>', { status: 400 });
    }

    const targetUrl = 'https://' + host + rest + url.search;
    const method = request.method;

    const headers = new Headers(request.headers);
    headers.set('Host', host);
    headers.delete('CF-Connecting-IP');
    headers.delete('CF-Worker');
    headers.delete('X-Forwarded-For');
    headers.delete('X-Real-IP');

    let body = null;
    if (method !== 'GET' && method !== 'HEAD') {
      body = request.body;
    }

    const fetchOptions = {
      method,
      headers,
      body,
      redirect: 'manual',
    };

    try {
      const resp = await fetch(targetUrl, fetchOptions);
      const respHeaders = new Headers(resp.headers);
      respHeaders.delete('Set-Cookie');
      respHeaders.delete('CF-Ray');
      respHeaders.delete('Server');

      const status = resp.status;
      if (status >= 300 && status < 400) {
        const location = resp.headers.get('Location');
        if (location) {
          if (location.startsWith('/')) {
            const redirected = new URL(location, targetUrl);
            return Response.redirect(redirected.toString(), status);
          }
          return Response.redirect(location, status);
        }
      }

      return new Response(resp.body, {
        status,
        headers: respHeaders,
      });
    } catch (e) {
      return new Response('SC_PROXY error: ' + e.message, { status: 502 });
    }
  },
};
