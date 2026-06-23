const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const fetch = require('node-fetch');
const os = require('os');
const net = require('net');
const { SocksProxyAgent } = require('socks-proxy-agent');

function killPort(port) {
  try {
    const pid = execSync(`fuser ${port}/tcp 2>/dev/null || ss -tlnp 'sport = :${port}' | grep -oP 'pid=\\K\\d+' || true`, { encoding: 'utf8', timeout: 3000 }).trim();
    if (pid) {
      console.log(`[warp] killing process on port ${port} (pid ${pid})`);
      process.kill(Number(pid), 'SIGKILL');
    }
  } catch (_) {}
  try { execSync(`fuser -k ${port}/tcp 2>/dev/null || true`, { timeout: 2000 }); } catch (_) {}
}

const WARP_DIR = path.join(__dirname, '..', '.warp');
const REG_FILE = path.join(WARP_DIR, 'registration.json');
const CONFIG_FILE = path.join(WARP_DIR, 'wireproxy.conf');
const BIN_DIR = path.join(WARP_DIR, 'bin');
const PID_FILE = path.join(WARP_DIR, 'wireproxy.pid');

const CF_API = 'https://api.cloudflareclient.com/v0a2158';
const WARP_PEER_PUBKEY = 'bmXOC+F1FxEMF9dyiK2H5/1SUtzH0JuVo51h2wPfgyo=';
const WARP_ENDPOINT = 'engage.cloudflareclient.com:2408';

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function generateKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  const privDer = privateKey.export({ type: 'pkcs8', format: 'der' });
  const rawPriv = privDer.slice(-32);
  const pubDer = publicKey.export({ type: 'spki', format: 'der' });
  const rawPub = pubDer.slice(-32);
  return {
    privateKey: Buffer.from(rawPriv).toString('base64'),
    publicKey: Buffer.from(rawPub).toString('base64'),
  };
}

async function registerDevice(publicKey) {
  const body = {
    install_id: '',
    tos: new Date().toISOString(),
    key: publicKey,
    fcm_token: '',
    type: 'Android',
    locale: 'en_US',
  };
  const r = await fetch(`${CF_API}/reg`, {
    method: 'POST',
    headers: {
      'User-Agent': 'okhttp/3.12.1',
      'Content-Type': 'application/json',
      'Cf-Client-Version': 'a-6.12-2158',
    },
    body: JSON.stringify(body),
    timeout: 10000,
  });
  if (!r.ok) throw new Error(`WARP registration failed: ${r.status}`);
  return r.json();
}

async function getOrCreateRegistration(forceNew) {
  if (!forceNew && fs.existsSync(REG_FILE)) {
    const raw = fs.readFileSync(REG_FILE, 'utf8');
    const reg = JSON.parse(raw);
    if (reg.privateKey && reg.config?.interface?.addresses?.v4) {
      console.log('[warp] loaded existing registration from file');
      return reg;
    }
  }
  if (fs.existsSync(REG_FILE)) fs.unlinkSync(REG_FILE);
  console.log('[warp] registering new WARP device...');
  const keys = generateKeyPair();
  const data = await registerDevice(keys.publicKey);
  const reg = {
    privateKey: keys.privateKey,
    publicKey: keys.publicKey,
    clientId: data.id,
    config: data.config,
    account: data.account,
    registeredAt: new Date().toISOString(),
  };
  ensureDir(WARP_DIR);
  fs.writeFileSync(REG_FILE, JSON.stringify(reg, null, 2));
  console.log('[warp] device registered, id:', data.id?.slice(0, 8));
  return reg;
}

function generateConfig(reg) {
  const v4 = reg.config.interface.addresses.v4;
  const lines = [
    '[Socks5]',
    'BindAddress = 127.0.0.1:1080',
    '',
    '[Interface]',
    `PrivateKey = ${reg.privateKey}`,
    `Address = ${v4}/32`,
    'DNS = 1.1.1.1',
    '',
    '[Peer]',
    `PublicKey = ${WARP_PEER_PUBKEY}`,
    `Endpoint = ${WARP_ENDPOINT}`,
    'AllowedIPs = 0.0.0.0/0, ::/0',
    'PersistentKeepalive = 25',
    '',
  ];
  return lines.join('\n');
}

function getPlatform() {
  const arch = os.arch();
  const plat = os.platform();
  const map = {
    'x64': 'amd64',
    'arm64': 'arm64',
    'arm': 'armv7',
  };
  const a = map[arch] || 'amd64';
  return { plat: plat === 'win32' ? 'windows' : plat === 'darwin' ? 'darwin' : 'linux', arch: a };
}

async function ensureWireproxyBin() {
  const { plat, arch } = getPlatform();
  const binPath = path.join(BIN_DIR, plat === 'windows' ? 'wireproxy.exe' : 'wireproxy');
  if (fs.existsSync(binPath)) return binPath;

  ensureDir(BIN_DIR);
  const url = `https://github.com/octeep/wireproxy/releases/latest/download/wireproxy_${plat}_${arch}.tar.gz`;
  console.log(`[warp] downloading wireproxy from ${url}...`);
  const r = await fetch(url, { timeout: 30000 });
  if (!r.ok) throw new Error(`download failed: ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());

  const tmpDir = path.join(WARP_DIR, 'tmp');
  ensureDir(tmpDir);
  const tarPath = path.join(tmpDir, 'wireproxy.tar.gz');
  fs.writeFileSync(tarPath, buf);

  execSync(`tar xzf "${tarPath}" -C "${tmpDir}"`, { stdio: 'pipe' });

  const extracted = fs.readdirSync(tmpDir).find(f => f.startsWith('wireproxy') && !f.endsWith('.gz') && !f.endsWith('.tar'));
  if (!extracted) throw new Error('wireproxy binary not found in archive');
  fs.renameSync(path.join(tmpDir, extracted), binPath);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.chmodSync(binPath, 0o755);
  console.log(`[warp] wireproxy installed at ${binPath}`);
  return binPath;
}

let _child = null;

async function testAdnViaSocks() {
  try {
    const agent = new SocksProxyAgent('socks5://127.0.0.1:1080');
    const r = await fetch('https://altadefinizionestreaming.com/api/player-sources/movie/27205', {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', 'Referer': 'https://altadefinizionestreaming.com/' },
      agent,
      timeout: 8000,
    });
    if (!r.ok) return false;
    const data = await r.json();
    return data && !data.unavailable;
  } catch { return false; }
}

async function start() {
  if (_child) return;

  const cfg = process.env.WARP_CONFIG || 'auto';
  if (cfg === 'off' || cfg === 'false' || cfg === '0') {
    console.log('[warp] disabled via WARP_CONFIG=off');
    return;
  }

  killPort(1080);
  await new Promise((r) => setTimeout(r, 300));

  for (let attempt = 0; attempt < 5; attempt++) {
    if (_child) { _child.kill(); _child = null; }
    try {
      const reg = await getOrCreateRegistration(attempt === 0 ? false : true);
      const config = generateConfig(reg);
      ensureDir(WARP_DIR);
      fs.writeFileSync(CONFIG_FILE, config);

      const binPath = await ensureWireproxyBin();
      console.log(`[warp] starting wireproxy (attempt ${attempt + 1}) on 127.0.0.1:1080...`);
      _child = spawn(binPath, ['-c', CONFIG_FILE], {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
      });

      _child.on('error', (err) => {
        console.error('[warp] wireproxy spawn error:', err.message);
        _child = null;
      });

      _child.stdout.on('data', (d) => {
        const s = d.toString().trim();
        if (s) console.log('[wireproxy]', s);
      });
      _child.stderr.on('data', (d) => {
        const s = d.toString().trim();
        if (s && !s.includes('TUN') && !s.startsWith('DEBUG:')) {
          console.log('[wireproxy]', s);
        }
      });

      _child.on('exit', (code) => {
        console.log(`[warp] wireproxy exited (code ${code}), restarting in 5s...`);
        _child = null;
        setTimeout(() => start(), 5000);
      });

      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('wireproxy start timeout')), 10000);
        const check = () => {
          const sock = net.createConnection(1080, '127.0.0.1', () => {
            sock.destroy();
            clearTimeout(timeout);
            resolve();
          });
          sock.on('error', () => {
            sock.destroy();
            setTimeout(check, 200);
          });
        };
        check();
      });

      console.log('[warp] wireproxy SOCKS5 ready');

      // Test if ADN works through this WARP IP
      const ok = await testAdnViaSocks();
      if (ok) {
        console.log('[warp] ADN accessible via this WARP IP');
        return;
      }
      console.log(`[warp] ADN not accessible via this WARP IP, retrying...`);
    } catch (e) {
      console.error(`[warp] attempt ${attempt + 1} failed:`, e.message);
    }
  }

  console.error('[warp] all 5 attempts failed, falling back to direct connections');
  if (_child) { _child.kill(); _child = null; }
}

async function stop() {
  if (_child) {
    _child.kill();
    _child = null;
    console.log('[warp] wireproxy stopped');
  }
}

async function status() {
  if (process.env.WARP_CONFIG === 'off') return { enabled: false, reason: 'disabled_by_config' };
  if (_child && _child.exitCode === null) return { enabled: true, running: true, pid: _child.pid };
  const regExists = fs.existsSync(REG_FILE);
  return { enabled: true, running: false, registered: regExists };
}

module.exports = { start, stop, status };
