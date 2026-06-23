require('dotenv').config();
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');

const als = new AsyncLocalStorage();

// --- Config encryption (AES-256-GCM) ---
// La chiave di encryption viene da:
//   1. CONFIG_ENCRYPTION_KEY env (priorità massima)
//   2. File .encryption_key nella root del progetto (auto-generato)
// Se nessuno dei due esiste, ne genera uno nuovo e lo salva su file.
const KEY_FILE = path.join(__dirname, '..', '.encryption_key');

function loadOrGenerateKey() {
  if (process.env.CONFIG_ENCRYPTION_KEY) {
    const raw = process.env.CONFIG_ENCRYPTION_KEY;
    return raw.length === 64 ? Buffer.from(raw, 'hex') : crypto.createHash('sha256').update(raw).digest();
  }
  try {
    if (fs.existsSync(KEY_FILE)) {
      return Buffer.from(fs.readFileSync(KEY_FILE, 'utf8').trim(), 'hex');
    }
  } catch (_) {}
  // Genera nuova chiave e salva
  const key = crypto.randomBytes(32);
  try {
    fs.writeFileSync(KEY_FILE, key.toString('hex'), 'utf8');
    console.log('[config] Chiave encryption generata e salvata in', KEY_FILE);
  } catch (_) {}
  return key;
}

const ENCRYPTION_KEY = loadOrGenerateKey();

function encodeConfig(obj) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
  let encrypted = cipher.update(JSON.stringify(obj || {}), 'utf8', 'base64url');
  encrypted += cipher.final('base64url');
  const tag = cipher.getAuthTag().toString('base64url');
  return `${iv.toString('base64url')}.${tag}.${encrypted}`;
}

function decodeConfig(str) {
  if (!str) return null;
  // Try encrypted format (iv.tag.encrypted)
  const parts = str.split('.');
  if (parts.length === 3 && parts[0].length > 0 && parts[1].length > 0 && parts[2].length > 0) {
    try {
      const iv = Buffer.from(parts[0], 'base64url');
      const tag = Buffer.from(parts[1], 'base64url');
      const encrypted = parts[2];
      const decipher = crypto.createDecipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
      decipher.setAuthTag(tag);
      let decrypted = decipher.update(encrypted, 'base64url', 'utf8');
      decrypted += decipher.final('utf8');
      const parsed = JSON.parse(decrypted);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch (_) {
      // Fallthrough to legacy format
    }
  }
  // Fallback: legacy base64 format (backward compat)
  try {
    const parsed = JSON.parse(Buffer.from(str, 'base64url').toString('utf8'));
    if (parsed && typeof parsed === 'object') return parsed;
    return null;
  } catch (_) {
    return null;
  }
}

// Esegue un handler dentro un context con la config dell'utente.
// La config si propaga automaticamente attraverso async/await.
function runWithConfig(userConfig, fn) {
  return als.run({ user: userConfig || {} }, fn);
}

function getConfig() {
  const store = als.getStore();
  const user = store?.user || {};
  // Lingua content: 'it' (default, comportamento attuale) | 'en' | 'mixed'.
  // Backward-compat: link senza `lang` → 'it' → zero impatto su utenti IT esistenti.
  const lang = (user.lang === 'en' || user.lang === 'mixed') ? user.lang : 'it';
  return {
    port: parseInt(process.env.PORT || '7001', 10),
    host: process.env.HOST || (process.env.RENDER || process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1'),
    publicHost: process.env.PUBLIC_HOST || null,
    realdebridKey: user.rd || '',
    torboxKey: user.tb || '',
    maxResults: parseInt(process.env.MAX_RESULTS || '25', 10),
    lang,
  };
}

// Restituisce la config dell'utente corrente (per lazy URL building)
function getCurrentUserConfig() {
  const store = als.getStore();
  return store?.user || null;
}

module.exports = { getConfig, runWithConfig, encodeConfig, decodeConfig, getCurrentUserConfig };
