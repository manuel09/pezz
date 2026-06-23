const { chromium } = require('playwright');

const WARP_PROXY = process.env.WARP_PROXY || 'socks5://127.0.0.1:1080';
const PROBE_URL = 'https://vixsrc.to/api/movie/27205';
const REFRESH_INTERVAL = 20 * 60 * 1000;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

let browser = null;
let context = null;
let cookieJar = null;
let lastRefresh = 0;

async function getBrowser() {
  if (browser && browser.isConnected()) return browser;
  browser = await chromium.launch({
    headless: true,
    args: [
      `--proxy-server=${WARP_PROXY}`,
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
    ],
  });
  return browser;
}

async function solveOnce() {
  const b = await getBrowser();
  if (context) await context.close();
  context = await b.newContext({ userAgent: UA });
  const page = await context.newPage();
  try {
    await page.goto(PROBE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    try {
      await page.waitForFunction(
        () => document.title !== 'Just a moment...',
        { timeout: 30000 }
      );
    } catch {
      // Se il timeout scade, controlliamo se siamo comunque passati
      const title = await page.title();
      const body = await page.evaluate(() => document.body?.innerText?.slice(0, 200) || '');
      if (title === 'Just a moment...' && !body.includes('src') && !body.includes('{')) {
        throw new Error('cf-solver: challenge not resolved');
      }
    }
    const raw = await context.cookies();
    const cf = {};
    for (const c of raw) {
      if (c.name.startsWith('__cf') || c.name === 'cf_clearance') {
        cf[c.name] = c.value;
      }
    }
    // Includiamo anche tutti i cookie perché alcuni servizi ne usano altri
    for (const c of raw) {
      cf[c.name] = c.value;
    }
    cookieJar = cf;
    lastRefresh = Date.now();
    console.log('[cf-solver] cookies refreshed:', Object.keys(cookieJar).join(', '));
    return cookieJar;
  } finally {
    await page.close();
  }
}

async function getCookies(force) {
  if (force || !cookieJar || Date.now() - lastRefresh > REFRESH_INTERVAL) {
    await solveOnce();
  }
  return cookieJar || {};
}

function getCookieHeader(jar) {
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
}

async function closeBrowser() {
  if (browser) {
    try { await browser.close(); } catch {}
  }
  browser = null;
  context = null;
  cookieJar = null;
  lastRefresh = 0;
}

async function warmup() {
  await getCookies(false);
}

module.exports = { getCookies, getCookieHeader, solveOnce, closeBrowser, warmup };
