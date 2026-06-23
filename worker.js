// Cloudflare Worker — CinemaCity reverse proxy
// Rewrites cinemacity.cc → this worker's domain, then proxies all requests.
// This allows the page to load correctly with all resources flowing through us.
//
// URL rewriting is critical: the page HTML contains absolute URLs to
// cinemacity.cc which would be blocked by CF if loaded directly.

const UPSTREAM = 'https://cinemacity.cc';
const UA = 'Mozilla/5.0';

async function fetchUpstream(url, request) {
  const headers = new Headers();
  headers.set('User-Agent', request.headers.get('User-Agent') || UA);
  const accept = request.headers.get('Accept');
  if (accept) headers.set('Accept', accept);
  const acceptLang = request.headers.get('Accept-Language');
  if (acceptLang) headers.set('Accept-Language', acceptLang);
  const referer = request.headers.get('Referer');
  if (referer) headers.set('Referer', referer);

  return fetch(url, {
    method: request.method,
    headers,
    redirect: 'follow',
  });
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const workerHost = url.host;
    const targetUrl = UPSTREAM + url.pathname + url.search;

    try {
      const upstream = await fetchUpstream(targetUrl, request);
      const contentType = upstream.headers.get('Content-Type') || '';

      let body = upstream.body;
      let respHeaders = new Headers(upstream.headers);
      respHeaders.set('Access-Control-Allow-Origin', '*');
      respHeaders.delete('Set-Cookie');
      respHeaders.delete('CF-Ray');
      respHeaders.delete('Server');
      respHeaders.delete('Report-To');
      respHeaders.delete('NEL');

      // Rewrite HTML: replace cinemacity.cc with our worker host
      if (contentType.includes('text/html') || contentType.includes('application/xhtml')) {
        let html = await upstream.text();
        html = html.replace(/https?:\/\/cinemacity\.cc/g, 'https://' + workerHost);
        html = html.replace(/cinemacity\.cc/g, workerHost);
        // Also rewrite protocol-relative URLs
        html = html.replace(/"\/\//g, '"https://');
        
        respHeaders.delete('Content-Length');
        respHeaders.delete('Content-Encoding');
        respHeaders.delete('Transfer-Encoding');
        
        return new Response(html, {
          status: upstream.status,
          headers: respHeaders,
        });
      }

      return new Response(body, {
        status: upstream.status,
        headers: respHeaders,
      });
    } catch (e) {
      return new Response('CC Proxy error: ' + e.message, { status: 502 });
    }
  },
};
