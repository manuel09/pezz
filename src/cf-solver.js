const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

chromium.use(StealthPlugin());

const WARP_PROXY = process.env.WARP_PROXY || 'socks5://127.0.0.1:1080';
const REFRESH_INTERVAL = 20 * 60 * 1000; // 20 min — CF clearance typically lasts 30 min
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

let browser = null;
let context = null;
const cookieJars = new Map(); // domain → { cookies: {}, lastRefresh: ts }

async function getBrowser() {
  if (browser && browser.isConnected()) return browser;
  browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  });
  return browser;
}

function extractCfCookies(raw, domain) {
  const cf = {};
  for (const c of raw) {
    if (c.domain && !c.domain.includes(domain.replace(/^www\./, ''))) continue;
    cf[c.name] = c.value;
  }
  return cf;
}

async function solveOnce(url, domain) {
  const b = await getBrowser();
  if (context) await context.close();
  context = await b.newContext({ userAgent: UA });
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40000 });
    // Wait for CF challenge to resolve — stealth plugin helps here
    try {
      await page.waitForFunction(
        () => {
          const title = document.title;
          return title !== 'Just a moment...' && title !== 'Ci siamo quasi…' && title !== 'Verifying...' && title !== '';
        },
        { timeout: 35000 }
      );
    } catch {
      // Challenge might have resolved but title stayed the same
      const bodyLen = await page.evaluate(() => document.body.innerText.length);
      if (bodyLen < 500) {
        throw new Error('cf-solver: challenge not resolved for ' + url);
      }
    }
    const raw = await context.cookies();
    const cookies = extractCfCookies(raw, domain);
    cookieJars.set(domain, { cookies, lastRefresh: Date.now() });
    console.log('[cf-solver] cookies refreshed for', domain, ':', Object.keys(cookies).join(', '));
    return cookies;
  } finally {
    await page.close();
  }
}

async function getCookies(url, force) {
  let domain;
  try { domain = new URL(url).hostname.replace(/^www\./, ''); } catch { return {}; }

  const jar = cookieJars.get(domain);
  if (!force && jar && Date.now() - jar.lastRefresh < REFRESH_INTERVAL) {
    return jar.cookies || {};
  }
  try {
    const homeUrl = `https://${domain}/`;
    return await solveOnce(homeUrl, domain);
  } catch (e) {
    console.error('[cf-solver] failed for', domain, ':', e.message);
    return jar ? jar.cookies : {};
  }
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
  cookieJars.clear();
}

async function warmup(url) {
  await getCookies(url, false);
}

module.exports = { getCookies, getCookieHeader, solveOnce, closeBrowser, warmup };
