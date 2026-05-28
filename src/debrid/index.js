const { getConfig } = require('../config');
const realdebrid = require('./realdebrid');
const torbox = require('./torbox');

// Lista di TUTTI i provider configurati. L'utente può avere RD, TB o entrambi —
// in quest'ultimo caso mostriamo i risultati da entrambe le fonti (così non
// ne perdiamo nessuna). TB prima perché è più veloce (batch check 1 request).
function activeProviders() {
  const c = getConfig();
  const out = [];
  if (c.torboxKey) out.push(torbox);
  if (c.realdebridKey) out.push(realdebrid);
  return out;
}

// Backward compat — alcuni call site usano ancora "il" provider attivo.
function activeProvider() {
  return activeProviders()[0] || null;
}

module.exports = { activeProvider, activeProviders };
