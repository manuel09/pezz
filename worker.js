// Cloudflare Worker — CinemaCity reverse proxy
// Trasparente: ogni richiesta a questo worker viene inoltrata a cinemacity.cc
// con lo stesso path + query string.
//
// Esempio: GET /news_pages.xml → https://cinemacity.cc/news_pages.xml
//          GET /movies/123-title.html → https://cinemacity.cc/movies/123-title.html
//
// Posa su Cloudflare Workers e aggiorna WORKER_HOST in cinemacity.js.

const UPSTREAM = 'https://cinemacity.cc';

const UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const targetUrl = UPSTREAM + url.pathname + url.search;

    const headers = new Headers();
    headers.set('User-Agent', request.headers.get('User-Agent') || UA);
    headers.set('Accept', request.headers.get('Accept') || 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8');
    headers.set('Accept-Language', request.headers.get('Accept-Language') || 'it-IT,it;q=0.9,en;q=0.8');

    const referer = request.headers.get('Referer');
    if (referer) headers.set('Referer', referer);
    else headers.set('Referer', UPSTREAM + '/');

    try {
      const upstream = await fetch(targetUrl, {
        method: request.method,
        headers,
        redirect: 'follow',
      });

      const respHeaders = new Headers(upstream.headers);
      respHeaders.set('Access-Control-Allow-Origin', '*');
      respHeaders.delete('Set-Cookie');
      respHeaders.delete('CF-Ray');
      respHeaders.delete('Server');
      respHeaders.delete('Report-To');
      respHeaders.delete('NEL');

      return new Response(upstream.body, {
        status: upstream.status,
        headers: respHeaders,
      });
    } catch (e) {
      return new Response('CC Proxy error: ' + e.message, { status: 502 });
    }
  },
};
