const nodeFetch = require('node-fetch');
const { SocksClient } = require('socks');
const https = require('https');
const http = require('http');
const tls = require('tls');

let _agentOk = false;
let _agentChecked = false;
let _socksAgent = null;

function getEnv() {
  return {
    warpEnabled: process.env.WARP_ENABLED === 'true',
    proxyUrl: process.env.WARP_PROXY || 'socks5://127.0.0.1:1080',
    excluded: new Set(
      (process.env.WARP_EXCLUDED_HOSTS || '')
        .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
    ),
    only: new Set(
      (process.env.WARP_PROXY_HOSTS || '')
        .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
    ),
  };
}

function shouldProxy(url) {
  const env = getEnv();
  if (!env.warpEnabled) return false;
  let host;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return false; }
  for (const e of env.excluded) {
    if (host === e || host.endsWith('.' + e)) return false;
  }
  if (env.only.size) {
    for (const m of env.only) {
      if (host === m || host.endsWith('.' + m)) return true;
    }
    return false;
  }
  return true;
}

async function isProxyAvailable() {
  const env = getEnv();
  if (!env.warpEnabled) return false;
  if (_agentChecked) return _agentOk;
  try {
    await nodeFetch('http://www.gstatic.com/generate_204', {
      agent: _socksAgent || getSocksAgent(env.proxyUrl),
      timeout: 4000,
      method: 'HEAD',
    });
    _agentOk = true;
  } catch { _agentOk = false; }
  _agentChecked = true;
  return _agentOk;
}

function resetProxyCheck() {
  _agentChecked = false;
}

function getSocksAgent(proxyUrl) {
  if (_socksAgent) return _socksAgent;
  const p = new URL(proxyUrl);
  const proxyHost = p.hostname;
  const proxyPort = parseInt(p.port) || 1080;

  _socksAgent = new (class extends https.Agent {
    createConnection(options, cb) {
      SocksClient.createConnection({
        proxy: { host: proxyHost, port: proxyPort, type: 5 },
        command: 'connect',
        destination: { host: options.host, port: options.port },
        timeout: 15000,
      }).then(({ socket }) => {
        socket.setKeepAlive(false);
        // Wrap in TLS for HTTPS
        const tlsSocket = tls.connect({
          socket,
          servername: options.servername || options.host,
          host: options.host,
          port: options.port,
          rejectUnauthorized: false,
        });
        tlsSocket.on('error', () => {});
        cb(null, tlsSocket);
      }).catch((err) => {
        cb(err);
      });
    }
  })({ keepAlive: false, timeout: 15000 });

  return _socksAgent;
}

async function proxyFetch(url, opts = {}) {
  const env = getEnv();
  const useProxy = shouldProxy(url);
  if (useProxy) {
    opts = { ...opts, agent: getSocksAgent(env.proxyUrl), timeout: opts.timeout || 15000 };
  }
  return nodeFetch(url, opts);
}

module.exports = {
  fetch: proxyFetch,
  proxyFetch,
  isProxyAvailable,
  resetProxyCheck,
  shouldProxy,
  get WARP_ENABLED() { return getEnv().warpEnabled; },
  get WARP_PROXY() { return getEnv().proxyUrl; },
  get WARP_EXCLUDED() { return getEnv().excluded; },
  get WARP_ONLY() { return getEnv().only; },
};
