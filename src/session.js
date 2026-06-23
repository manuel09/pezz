const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SESSION_FILE = path.join(__dirname, '..', '.sessions.json');

const sessions = new Map();
let dirty = false;
let saveTimer = null;

function load() {
  try {
    if (fs.existsSync(SESSION_FILE)) {
      const raw = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
      for (const [k, v] of Object.entries(raw)) {
        sessions.set(k, v);
      }
    }
  } catch (_) {}
}

function save() {
  try {
    const obj = Object.fromEntries(sessions.entries());
    fs.writeFileSync(SESSION_FILE, JSON.stringify(obj), 'utf8');
    dirty = false;
  } catch (_) {}
}

function markDirty() {
  dirty = true;
  if (!saveTimer) {
    saveTimer = setTimeout(() => {
      saveTimer = null;
      if (dirty) save();
    }, 5000);
  }
}

function createSession(config) {
  const sessionId = crypto.randomBytes(16).toString('hex');
  const session = {
    config: { ...config },
    createdAt: Date.now(),
  };
  sessions.set(sessionId, session);
  markDirty();
  return sessionId;
}

function getSession(sessionId) {
  if (!sessionId || !/^[a-f0-9]{32}$/i.test(sessionId)) return null;
  return sessions.get(sessionId) || null;
}

function deleteSession(sessionId) {
  const ok = sessions.delete(sessionId);
  if (ok) markDirty();
  return ok;
}

load();
setInterval(() => { if (dirty) save(); }, 30000);
process.on('exit', () => { if (dirty) save(); });

module.exports = { createSession, getSession, deleteSession };
