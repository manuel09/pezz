const fetch = require('node-fetch');
const { SocksClient } = require('socks');
const https = require('https');
const tls = require('tls');

const PROXY_SOURCES = [
  'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt',
  'https://api.proxyscrape.com/v2/?request=getproxies&protocol=socks5&timeout=10000&country=all',
  'https://raw.githubusercontent.com/hookzof/socks5_list/master/proxy.txt',
  'https://raw.githubusercontent.com/BlackDragonBE/ProxyScraper/master/socks5.txt',
];

const TEST_URL = 'https://vixsrc.to/api/movie/603';
const MAX_POOL = 25;
const MAX_TEST = 300;
const REFRESH_MS = 10 * 60 * 1000;
const TEST_TIMEOUT = 6000;
const BATCH_SIZE = 15;

const TEST_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
  'Accept': 'application/json,*/*',
  'Accept-Language': 'it-IT,it;q=0.9,en;q=0.8',
  'Referer': 'https://vixsrc.to/',
};

let pool = [];
let lastRefresh = 0;
let refreshing = false;
let _readyResolve;
const _ready = new Promise(r => { _readyResolve = r; });
let _readyCalled = false;

function makeAgent(host, port) {
  return new (class extends https.Agent {
    createConnection(options, cb) {
      SocksClient.createConnection({
        proxy: { host, port, type: 5 },
        command: 'connect',
        destination: { host: options.host, port: options.port },
        timeout: 10000,
      }).then(({ socket }) => {
        socket.setKeepAlive(false);
        const tlsSocket = tls.connect({
          socket,
          servername: options.servername || options.host,
          host: options.host,
          port: options.port,
          rejectUnauthorized: false,
        });
        tlsSocket.on('error', () => {});
        cb(null, tlsSocket);
      }).catch((err) => cb(err));
    }
  })({ keepAlive: false, timeout: 15000 });
}

const agentCache = new Map();
function getCachedAgent(host, port) {
  const key = `${host}:${port}`;
  let a = agentCache.get(key);
  if (!a) {
    a = makeAgent(host, port);
    agentCache.set(key, a);
  }
  return a;
}

async function testProxy(host, port) {
  try {
    const agent = getCachedAgent(host, port);
    const r = await fetch(TEST_URL, {
      agent,
      timeout: TEST_TIMEOUT,
      headers: TEST_HEADERS,
    });
    const ct = r.headers.get('content-type') || '';
    if (r.ok && ct.includes('json')) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

async function fetchProxies(url) {
  try {
    const r = await fetch(url, { timeout: 10000 });
    const text = await r.text();
    const set = new Set();
    for (const line of text.split('\n')) {
      const p = line.trim();
      if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d+$/.test(p)) {
        set.add(p);
      }
    }
    return [...set];
  } catch {
    return [];
  }
}

async function refresh() {
  if (refreshing) return;
  refreshing = true;

  const all = new Set();
  const results = await Promise.allSettled(PROXY_SOURCES.map(fetchProxies));
  for (const r of results) {
    if (r.status === 'fulfilled') {
      for (const p of r.value) all.add(p);
    }
  }

  let entries = [...all];
  if (!entries.length) {
    refreshing = false;
    if (!_readyCalled) { _readyCalled = true; _readyResolve(); }
    return;
  }

  // Shuffle e limita
  for (let i = entries.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [entries[i], entries[j]] = [entries[j], entries[i]];
  }
  if (entries.length > MAX_TEST) entries = entries.slice(0, MAX_TEST);

  console.log(`[proxy-pool] testing up to ${entries.length} proxies against SC API...`);

  const working = [];
  for (let i = 0; i < entries.length && working.length < MAX_POOL; i += BATCH_SIZE) {
    const batch = entries.slice(i, i + BATCH_SIZE);
    const tested = await Promise.allSettled(
      batch.map(p => {
        const [h, pt] = p.split(':');
        return testProxy(h, parseInt(pt));
      })
    );
    for (let j = 0; j < tested.length; j++) {
      if (tested[j].status === 'fulfilled' && tested[j].value) {
        const [h, pt] = batch[j].split(':');
        working.push({ host: h, port: parseInt(pt) });
        if (working.length >= MAX_POOL) break;
      }
    }

    // Popola il pool incrementalmente dopo ogni batch
    if (working.length > 0) {
      pool = [...working];
      if (!_readyCalled) { _readyCalled = true; _readyResolve(); }
    }
  }

  pool = working;
  lastRefresh = Date.now();
  refreshing = false;
  if (!_readyCalled) { _readyCalled = true; _readyResolve(); }

  console.log(`[proxy-pool] ${working.length} working proxies (from ${entries.length} tested)`);
}

function getProxy() {
  if (!pool.length) return null;
  return pool[Math.floor(Math.random() * pool.length)];
}

function poolSize() {
  return pool.length;
}

// Avvia refresh immediato e poi ogni REFRESH_MS
let initDone = false;
function ensureInit() {
  if (initDone) return;
  initDone = true;
  refresh();
  setInterval(() => refresh(), REFRESH_MS);
}

async function waitReady() {
  if (pool.length > 0) return;
  await _ready;
}

module.exports = { getProxy, poolSize, refresh, ensureInit, testProxy, getCachedAgent, makeAgent, waitReady };
