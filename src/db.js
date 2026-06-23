const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DB_PATH = path.join(__dirname, '..', 'profiles_db.json');
const CONFIG_KEY_FILE = path.join(__dirname, '..', '.config_key');
const ENC_PREFIX = 'enc:';

let db = {};
let configEncryptionKey = null;

function loadOrGenerateConfigKey() {
  if (process.env.PROFILES_ENCRYPTION_KEY) {
    const raw = process.env.PROFILES_ENCRYPTION_KEY;
    return raw.length === 64 ? Buffer.from(raw, 'hex') : crypto.createHash('sha256').update(raw).digest();
  }
  try {
    if (fs.existsSync(CONFIG_KEY_FILE)) {
      return Buffer.from(fs.readFileSync(CONFIG_KEY_FILE, 'utf8').trim(), 'hex');
    }
  } catch (_) {}
  const key = crypto.randomBytes(32);
  try {
    fs.writeFileSync(CONFIG_KEY_FILE, key.toString('hex'), 'utf8');
    console.log('[db] Chiave encryption profili generata in', CONFIG_KEY_FILE);
  } catch (_) {}
  return key;
}

function encryptProfileConfig(config) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', configEncryptionKey, iv);
  let enc = cipher.update(JSON.stringify(config), 'utf8', 'base64url');
  enc += cipher.final('base64url');
  const tag = cipher.getAuthTag().toString('base64url');
  return ENC_PREFIX + iv.toString('base64url') + '.' + tag + '.' + enc;
}

function decryptProfileConfig(encrypted) {
  if (!encrypted || typeof encrypted !== 'string') return null;
  if (!encrypted.startsWith(ENC_PREFIX)) {
    try { return JSON.parse(typeof encrypted === 'string' ? encrypted : JSON.stringify(encrypted)); } catch (_) { return null; }
  }
  try {
    const data = encrypted.slice(ENC_PREFIX.length);
    const parts = data.split('.');
    if (parts.length !== 3) return null;
    const iv = Buffer.from(parts[0], 'base64url');
    const tag = Buffer.from(parts[1], 'base64url');
    const decipher = crypto.createDecipheriv('aes-256-gcm', configEncryptionKey, iv);
    decipher.setAuthTag(tag);
    let dec = decipher.update(parts[2], 'base64url', 'utf8');
    dec += decipher.final('utf8');
    return JSON.parse(dec);
  } catch (_) {
    return null;
  }
}

function generateProfileId() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id;
  do {
    id = '';
    const bytes = crypto.randomBytes(10);
    for (let i = 0; i < 10; i++) {
      id += chars[bytes[i] % chars.length];
    }
  } while (db[id]);
  return id;
}

function load() {
  try {
    if (fs.existsSync(DB_PATH)) {
      const data = fs.readFileSync(DB_PATH, 'utf8');
      db = JSON.parse(data);
    }
  } catch (e) {
    console.error('[db] Load error:', e.message);
    db = {};
  }
}

function save() {
  try {
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf8');
  } catch (e) {
    console.error('[db] Save error:', e.message);
  }
}

configEncryptionKey = loadOrGenerateConfigKey();
load();

module.exports = {
  get: (id) => db[id],
  set: (id, data) => { db[id] = data; save(); },
  update: (id, updates) => { if (db[id]) { db[id] = { ...db[id], ...updates }; save(); } },
  delete: (id) => { if (db[id]) { delete db[id]; save(); return true; } return false; },
  getAll: () => db,

  createProfile: (name, config) => {
    const id = generateProfileId();
    const encrypted = encryptProfileConfig(config);
    db[id] = {
      name,
      config: encrypted,
      createdAt: new Date().toISOString(),
      lastUsed: null,
    };
    save();
    return id;
  },

  getProfileConfig: (id) => {
    const entry = db[id];
    if (!entry) return null;
    return decryptProfileConfig(entry.config);
  },

  updateProfile: (id, updates) => {
    if (!db[id]) return false;
    if (updates.config) updates.config = encryptProfileConfig(updates.config);
    db[id] = { ...db[id], ...updates };
    if (updates.name) db[id].name = updates.name;
    save();
    return true;
  },

  touchProfile: (id) => {
    if (!db[id]) return;
    db[id].lastUsed = Date.now();
    save();
  },
};
