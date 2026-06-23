// AIOStreams-compatible stream formatter.
// AIOStreams parsa name + title degli addon che aggrega per uniformare il layout.
// Conventions:
//   name: "AddonName SERVICE_ABBR{symbol}\nquality"
//     - SERVICE_ABBR: RD | TB | AD | P2P
//     - symbol: ⚡ cached, ⏳ uncached, niente per P2P/HTTP
//   title: multi-line con emoji
//     - 🎬 / 🗳️ titolo / pack
//     - 📂 file (per pack)
//     - 💾 size
//     - 🗣️ lingua
//     - 🔗 source 👥 seeders

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

function formatName({ addonName = 'ItaHub', service, cached, quality, hasError = false }) {
  const svcKey = String(service || 'p2p').toLowerCase();
  const abbr = SERVICE_ABBR[svcKey] || 'P2P';
  const errorTag = hasError ? ' ⚠️' : '';
  const q = quality || 'Unknown';

  // Servizi senza concetto di cache: HTTP / P2P
  if (abbr === 'HTTP' || abbr === 'P2P') {
    return `${addonName} ${abbr}${errorTag}\n${q}`;
  }
  // Debrid: aggiungi simbolo cache
  const sym = cached ? '⚡' : '⏳';
  return `${addonName} ${abbr}${sym}${errorTag}\n${q}`;
}

function formatTitle({ title, size, language, source, seeders, isPack = false, episodeTitle }) {
  const lines = [];
  // Riga 1: titolo (pack o singolo)
  if (isPack) {
    lines.push(`🗳️ ${title}`);
    if (episodeTitle) lines.push(`📂 ${episodeTitle}`);
  } else {
    lines.push(`🎬 ${title}`);
  }
  // Riga 2: size
  if (size) lines.push(`💾 ${size}`);
  // Riga 3: lingua
  if (language) lines.push(`🗣️ ${language}`);
  // Riga 4: source + seeders
  const sourceInfo = [];
  if (source) sourceInfo.push(`🔗 ${source}`);
  if (seeders !== undefined && seeders !== null && seeders >= 0) {
    sourceInfo.push(`👥 ${seeders}`);
  }
  if (sourceInfo.length) lines.push(sourceInfo.join(' '));
  return lines.join('\n');
}

module.exports = { formatName, formatTitle };
