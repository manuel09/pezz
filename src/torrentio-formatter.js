// Torrentio-style stream formatter.
// Layout familiare alla maggior parte degli utenti Stremio che vengono da
// addon tipo Torrentio / IlCorsaroViola:
//   name:        "[SERVICE⚡] ItaHub quality"
//                (una riga, parentesi quadra, simbolo cache)
//   description: "🎬 filename
//                💾 size 👤 seeders
//                🇮🇹 / 🇬🇧"

const SERVICE_ABBR = {
  realdebrid: 'RD',
  rd: 'RD',
  torbox: 'TB',
  tb: 'TB',
  alldebrid: 'AD',
  ad: 'AD',
  http: 'HTTP',
  p2p: 'P2P',
  // Provider HTTP italiani — bracket esplicito così l'utente vede al volo
  // da che sorgente arriva lo stream (stile Torrentio classico)
  aw: 'AW',
  as: 'AS',
  au: 'AU',
  gs: 'GS',
  sc: 'SC',
};

// Provider HTTP "diretti" — niente simbolo cache, sono già pronti
const DIRECT_HTTP_PROVIDERS = new Set(['AW', 'AS', 'AU', 'GS', 'SC', 'HTTP', 'P2P']);

const LANG_FLAG = {
  italian: '🇮🇹', ita: '🇮🇹', it: '🇮🇹',
  english: '🇬🇧', eng: '🇬🇧', en: '🇬🇧',
  spanish: '🇪🇸', spa: '🇪🇸', es: '🇪🇸',
  french: '🇫🇷', fre: '🇫🇷', fr: '🇫🇷',
  german: '🇩🇪', ger: '🇩🇪', de: '🇩🇪',
  japanese: '🇯🇵', jpn: '🇯🇵', ja: '🇯🇵',
  multi: '🌎',
};

function langsToFlags(langs) {
  if (!langs) return [];
  const arr = Array.isArray(langs) ? langs : [langs];
  return arr.map((l) => LANG_FLAG[String(l).toLowerCase()] || '').filter(Boolean);
}

function formatName({ addonName = 'ItaHub', service, cached, quality }) {
  const svcKey = String(service || 'p2p').toLowerCase();
  const abbr = SERVICE_ABBR[svcKey] || 'P2P';
  const q = quality || 'Unknown';

  // Provider HTTP italiani + P2P: tag esplicito senza simbolo cache
  // (AW/AS/AU/GS/SC sono direct stream, non hanno il concetto di cached)
  if (DIRECT_HTTP_PROVIDERS.has(abbr)) {
    return `[${abbr}] ${addonName} ${q}`;
  }
  // Debrid: brackets + simbolo cache (⚡ cached, ⏳ in download)
  const sym = cached ? '⚡' : '⏳';
  return `[${abbr}${sym}] ${addonName} ${q}`;
}

function formatTitle({ filename, size, languages, isPack = false, packName, episodeName }) {
  const lines = [];
  // Riga 1: file principale (o pack/episode breakdown)
  if (isPack && packName) {
    lines.push(`🗳️ ${packName}`);
    if (episodeName) lines.push(`📂 ${episodeName}`);
  } else if (filename) {
    lines.push(`🎬 ${filename}`);
  }
  // Riga 2: size (i seeders non sono affidabili — alcuni aggregator
  // riportano 0 anche su torrent con centinaia di peer, fuorvianti)
  if (size) lines.push(`💾 ${size}`);
  // Riga 3: lingue
  const flags = langsToFlags(languages);
  if (flags.length) lines.push(flags.join(' / '));
  return lines.join('\n');
}

// Estrae un filename leggibile dall'URL dello stream.
// Per AW (MP4 diretto) ritorna es. "Naruto_Ep_001_ITA.mp4".
// Per i proxy interni /hls/{prov}/.../master.m3u8 ritorna null (filename
// generico inutile) — il chiamante userà un fallback descrittivo.
function extractFilename(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    const u = new URL(url);
    const path = u.pathname;
    // Skip proxy interni: master.m3u8/playlist.m3u8 generici
    if (/\/(master|playlist)\.m3u8$/i.test(path)) return null;
    if (/^\/(hls|resolve|play|dl)\//i.test(path)) return null;
    const last = path.split('/').filter(Boolean).pop();
    if (!last) return null;
    const decoded = decodeURIComponent(last);
    // Skip "master.m3u8" anche se non in path proxy
    if (/^(master|playlist|index)\.m3u8$/i.test(decoded)) return null;
    return decoded;
  } catch (_) {
    return null;
  }
}

module.exports = { formatName, formatTitle, extractFilename };
