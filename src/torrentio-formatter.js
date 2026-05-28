// Torrentio-style stream formatter.
// Layout familiare alla maggior parte degli utenti Stremio che vengono da
// addon tipo Torrentio / IlCorsaroViola:
//   name:        "[SERVICE⚡] Pezzottio quality"
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
};

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

function formatName({ addonName = 'Pezzottio', service, cached, quality }) {
  const svcKey = String(service || 'p2p').toLowerCase();
  const abbr = SERVICE_ABBR[svcKey] || 'P2P';
  const q = quality || 'Unknown';

  // HTTP / P2P: niente simbolo cache, niente brackets debrid
  if (abbr === 'HTTP' || abbr === 'P2P') {
    return `[${abbr}] ${addonName} ${q}`;
  }
  // Debrid: brackets + simbolo cache
  const sym = cached ? '⚡' : '⏳';
  return `[${abbr}${sym}] ${addonName} ${q}`;
}

function formatTitle({ filename, size, seeders, languages, isPack = false, packName, episodeName }) {
  const lines = [];
  // Riga 1: file principale (o pack/episode breakdown)
  if (isPack && packName) {
    lines.push(`🗳️ ${packName}`);
    if (episodeName) lines.push(`📂 ${episodeName}`);
  } else if (filename) {
    lines.push(`🎬 ${filename}`);
  }
  // Riga 2: size + seeders
  const parts = [];
  if (size) parts.push(`💾 ${size}`);
  if (seeders !== undefined && seeders !== null && seeders >= 0) {
    parts.push(`👤 ${seeders}`);
  }
  if (parts.length) lines.push(parts.join(' '));
  // Riga 3: lingue
  const flags = langsToFlags(languages);
  if (flags.length) lines.push(flags.join(' / '));
  return lines.join('\n');
}

module.exports = { formatName, formatTitle };
