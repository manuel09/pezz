// Auto-prefetch del prossimo episodio su Torbox in background.
//
// Flusso:
//   1. Utente clicca play su S01E03 → /play handler risponde redirect 302
//   2. Subito DOPO il redirect, fire-and-forget prefetchNext(meta, S01E04)
//   3. prefetchNext cerca il pool del prossimo ep, prende il top hash cached
//      o richiede addMagnet a TB → TB inizia download in bg
//   4. Quando l'utente clicca S01E04 (~30-60min dopo), è già cached istantaneo
//
// Dedupe: un Set per evitare prefetch ripetuti dello stesso (imdb,S,E) negli
// ultimi 30 min (se l'utente ricarica /play più volte).

const _prefetched = new Map(); // key → timestamp
const PREFETCH_TTL = 30 * 60 * 1000; // 30 min

function _wasPrefetched(key) {
  const t = _prefetched.get(key);
  if (!t) return false;
  if (Date.now() - t > PREFETCH_TTL) {
    _prefetched.delete(key);
    return false;
  }
  return true;
}

function _markPrefetched(key) {
  if (_prefetched.size > 1000) {
    // GC: rimuovi le entry più vecchie di TTL
    const now = Date.now();
    for (const [k, ts] of _prefetched.entries()) {
      if (now - ts > PREFETCH_TTL) _prefetched.delete(k);
    }
  }
  _prefetched.set(key, Date.now());
}

function wasPrefetched(key) { return _wasPrefetched(key); }
function markPrefetched(key) { _markPrefetched(key); }

// Prefetch del prossimo episodio.
// Args:
//   imdbId: 'tt0903747' (id base senza :S:E)
//   season, episode: S/E correnti (il prossimo sarà E+1)
//   userCfg: config utente (per chiave TB e flag prefetchOff)
//   resolveStreams: async fn(meta, type, fullId) → pool di hash da considerare
//
// Strategia conservativa:
//   - Solo se la chiave TB è configurata (l'unico provider con prefetch utile)
//   - Solo serie (movie non ha "prossimo episodio")
//   - Skip se già prefetchato negli ultimi 30 min
//   - Trova primo hash TB-cached nel pool → addMagnet sull'account utente
//   - Fire-and-forget, errori ignorati (non blocca nulla)
async function prefetchNext({ imdbId, season, episode, userCfg, resolveStreams }) {
  try {
    if (!userCfg?.tb) return; // solo TB ha senso per prefetch
    if (!imdbId || !imdbId.startsWith('tt')) return;
    if (!season || !episode) return; // niente prefetch per movies
    if (userCfg.noPrefetch === true || userCfg.noPrefetch === 'true') return;

    const nextEp = episode + 1;
    const key = `${imdbId}:${season}:${nextEp}:${userCfg.tb.slice(0, 8)}`;
    if (_wasPrefetched(key)) return;
    _markPrefetched(key);

    // Risolvi pool del prossimo episodio
    const fullStremioId = `${imdbId}:${season}:${nextEp}`;
    const streams = await resolveStreams({ type: 'series', id: fullStremioId });
    if (!streams || !streams.length) return;

    // Trova hash dal magnet del primo stream "valido"
    // (filtri: ha infoHash, è cached su TB → l'addon resolveTorbox già emette solo cached)
    const target = streams.find((s) => {
      const u = s.url || '';
      // L'addon emette URL /play/HASH?s=X&e=Y. Estraggo l'hash.
      const m = u.match(/\/play\/([a-f0-9]{40})/i);
      return !!m;
    });
    if (!target) return;

    const m = target.url.match(/\/play\/([a-f0-9]{40})/i);
    const nextHash = m[1].toLowerCase();

    // addMagnet a TB. Reuse mylist se già presente (no-op).
    const fetch = require('node-fetch');
    const magnet = `magnet:?xt=urn:btih:${nextHash}&tr=udp://tracker.opentrackr.org:1337/announce`;
    const data = new URLSearchParams();
    data.append('magnet', magnet);
    data.append('allow_zip', 'false');
    const r = await fetch('https://api.torbox.app/v1/api/torrents/createtorrent', {
      method: 'POST',
      headers: { Authorization: `Bearer ${userCfg.tb}`, 'User-Agent': 'itahub-prefetch' },
      body: data,
      timeout: 5000,
    });
    const json = await r.json().catch(() => ({}));
    if (json?.success) {
      console.log(`[prefetch] +1 ${imdbId} S${season}E${nextEp} → ${nextHash.slice(0, 8)} (TB add OK)`);
    } else if (json?.error === 'ACTIVE_LIMIT') {
      console.log(`[prefetch] skip ${imdbId} S${season}E${nextEp}: TB ACTIVE_LIMIT`);
    }
  } catch (e) {
    // Fire-and-forget: ignora errori silenziosi
  }
}

module.exports = { prefetchNext, wasPrefetched, markPrefetched };
