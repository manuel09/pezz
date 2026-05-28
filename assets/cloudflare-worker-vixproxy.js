// Cloudflare Worker: VixSrc + CDN proxy
//
// Deploy:
//   1. Vai su dash.cloudflare.com → Workers & Pages → il Worker esistente
//   2. Edit code → cancella tutto → incolla questo → Save and Deploy
//   3. Su Render env vars: VIXSRC_PROXY=https://<worker>.workers.dev (immutato)
//
// Cosa fa:
//   Riceve richieste come {worker}/{HOST}/{PATH...} e le inoltra a https://{HOST}/{PATH...}.
//   HOST in allowlist:
//     - vixsrc.to                          → API, embed, master playlist, AES key
//     - sc-u{NN}-{NN}.vix-content.net      → CDN segment .ts
//
// Backward compat (se Render aggiorna il provider dopo il Worker):
//   Accetta anche /api/*, /embed/*, /playlist/* nudi → li forwarda a vixsrc.to
//
// Perché serve proxare anche il CDN: vixsrc.to firma i token segment usando l'IP
// del fetcher dell'embed. Se embed via Worker (IP CF) e segment da Render (IP Render),
// il CDN risponde 403. Routando tutto via Worker, IP coerente → 200.
//
// Limit: free tier CF Workers = 100K req/giorno. Un episodio 45min 1080p ≈ 675 segment.
// → ~148 cold view/giorno (poi le viste successive arrivano dal cache CF in front di pezz8io,
//   non passano dal Worker).

const HOST_ALLOWLIST = [
  /^vixsrc\.to$/,
  /^sc-u\d+-\d+\.vix-content\.net$/,
];

const FAKE_BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
  'Accept-Language': 'it-IT,it;q=0.9,en;q=0.8',
  'Referer': 'https://vixsrc.to/',
  'Origin': 'https://vixsrc.to',
};

const LEGACY_PATHS = ['/api/', '/embed/', '/playlist/'];

function resolveUpstream(url) {
  // Nuovo schema: /{HOST}/{PATH}
  // path = "/vixsrc.to/api/movie/603" → host=vixsrc.to, rest=/api/movie/603
  const segs = url.pathname.split('/').filter(Boolean); // ["vixsrc.to", "api", "movie", "603"]
  if (segs.length >= 1 && HOST_ALLOWLIST.some((re) => re.test(segs[0]))) {
    const host = segs[0];
    const rest = '/' + segs.slice(1).join('/');
    return `https://${host}${rest}${url.search}`;
  }
  // Backward compat: /api/, /embed/, /playlist/ nudi → vixsrc.to
  if (LEGACY_PATHS.some((p) => url.pathname.startsWith(p))) {
    return `https://vixsrc.to${url.pathname}${url.search}`;
  }
  return null;
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const upstreamUrl = resolveUpstream(url);
    if (!upstreamUrl) {
      return new Response('Forbidden: host not in allowlist', { status: 403 });
    }

    const upstream = await fetch(upstreamUrl, {
      method: 'GET',
      headers: {
        ...FAKE_BROWSER_HEADERS,
        ...(request.headers.get('range') ? { Range: request.headers.get('range') } : {}),
      },
    });

    const respHeaders = new Headers();
    for (const [k, v] of upstream.headers) {
      if (['set-cookie', 'cf-cache-status', 'cf-ray', 'server', 'alt-svc', 'nel', 'report-to'].includes(k.toLowerCase())) continue;
      respHeaders.set(k, v);
    }
    respHeaders.set('access-control-allow-origin', '*');

    return new Response(upstream.body, {
      status: upstream.status,
      headers: respHeaders,
    });
  },
};
