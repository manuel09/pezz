// Ordine: pattern più specifici prima. "2160p"/"UHD" sono inequivocabili;
// "4k" come fallback solo se nessun marker di risoluzione esplicita.
const QUALITY = [
  { re: /\b(2160p|uhd)\b/i, label: '4K' },
  { re: /\b(1080p|fullhd)\b/i, label: '1080p' },
  { re: /\b(720p)\b/i, label: '720p' },
  { re: /\b(480p)\b/i, label: '480p' },
  { re: /\b(cam|hdts|telesync)\b/i, label: 'CAM' },
];

function parseQuality(name) {
  for (const q of QUALITY) if (q.re.test(name)) return q.label;
  if (/\b4k\b/i.test(name)) return '4K';
  return null;
}

function isHDR(name) {
  return /\b(hdr10\+?|hdr|dolby.?vision|dv)\b/i.test(name || '');
}

function normalize(s) {
  return (s || '')
    .normalize('NFD')                     // separa lettere base da segni combining (à → a + ̀)
    .replace(/[̀-ͯ]/g, '')      // rimuove gli accenti (Totò → Toto)
    .toLowerCase()
    .replace(/['`’]/g, '')
    .replace(/[._\-:,!?()\[\]{}+&/\\]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const STOPWORDS = new Set(['the', 'a', 'an', 'of', 'and', 'or', 'di', 'la', 'il', 'lo', 'le', 'i', 'gli', 'un', 'una', 'e']);

function significantWords(title) {
  return normalize(title)
    .split(' ')
    .filter((w) => w && (w.length > 2 || /^\d+$/.test(w)) && !STOPWORDS.has(w));
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Verifica che il torrent name sia coerente col film/serie cercato.
// Per i film: anno deve matchare con tolleranza (±3 anni) per coprire remaster/re-rip;
// se il torrent contiene PIÙ anni accettiamo se almeno uno matcha.
// Per le serie: l'anno è ignorato (meta.year è l'anno di start; gli episodi
// possono essere di stagioni successive con anno diverso).
// Per tutti: tutte le parole significative del titolo devono essere presenti.
function titleMatches(torrentName, meta, opts = {}) {
  const norm = normalize(torrentName);
  const checkYear = opts.checkYear !== false; // di default true
  if (checkYear && meta.year) {
    const years = [...norm.matchAll(/\b(19|20)\d{2}\b/g)].map((m) => parseInt(m[0], 10));
    if (years.length > 0) {
      const my = parseInt(meta.year, 10);
      const anyMatches = years.some((ty) => Math.abs(ty - my) <= 3);
      if (!anyMatches) return false;
    }
  }
  // Matcha contro titolo originale OPPURE titolo italiano (se diverso).
  // Molti torrent ITA usano il titolo localizzato (es. "Il Mentalista" invece
  // di "The Mentalist", "Squadra Speciale Cobra" invece di "Alarm für Cobra").
  function _allWordsIn(title) {
    const words = significantWords(title);
    if (!words.length) return true;
    for (const w of words) {
      const re = new RegExp(`(?:^|[^a-z0-9])${escapeRe(w)}(?:$|[^a-z0-9])`, 'i');
      if (!re.test(norm)) return false;
    }
    return true;
  }
  if (_allWordsIn(meta.title)) return true;
  if (meta.italianTitle && meta.italianTitle !== meta.title && _allWordsIn(meta.italianTitle)) return true;
  return false;
}

// Estrae la "parte show" dal nome del torrent: tutto ciò che precede SxxExx/NxNN/Season N.
// Serve per rilevare titoli spinoff (es. "Law & Order: SVU" vs "Law & Order").
// Riconosce anche pack (S01 senza E, Complete, Stagione N) e parentesi/brackets.
function showPortion(torrentName) {
  const split = torrentName.split(/\s(?=[\[(])|[._\s\-]+(?=s\d{1,2}(?:e\d{1,3})?\b|\d{1,2}x\d{1,3}\b|season[\s._\-]?\d+|complete\b|stagione[\s._\-]?\d+|\(?\d{4}\)?[\s\-_.]+(?:s\d|complete))/i);
  return split[0] || torrentName;
}

// Match stretto per serie TV: oltre a verificare che tutte le parole del titolo
// siano presenti, controlla che la "parte show" del torrent NON contenga parole
// significative EXTRA (= titolo diverso, tipico degli spinoff).
// Es. meta="Law & Order" → "Law & Order: SVU S01E01" viene RIFIUTATO (svu è extra).
// Token comuni nei nomi di release che NON sono parte del titolo show:
// lingue, qualità, codec, source, sigle gruppi. Se compaiono nella "parte show"
// non devono essere considerati 'parole extra' (= spinoff).
// Le sigle dei VERI spinoff (SVU, NCIS LA, CSI NY, Toronto, Vigilantes, ecc.)
// NON sono in questa lista e quindi vengono ancora rigettate.
const RELEASE_NOISE_TOKENS = new Set([
  // lingue audio
  'ita', 'italian', 'italiano', 'eng', 'english', 'fre', 'french', 'fra',
  'ger', 'german', 'deu', 'spa', 'spanish', 'jpn', 'japanese', 'rus', 'russian',
  'multi', 'multilang', 'multilingua', 'dual', 'dub', 'dubbed', 'audio', 'lang',
  // sub
  'sub', 'subs', 'subbed', 'subita', 'multisub', 'forced', 'cc',
  // qualità / risoluzione
  '480p', '720p', '1080p', '1440p', '2160p', '4k', 'uhd', 'fhd', 'fullhd', 'hd', 'sd',
  // source
  'web', 'webdl', 'webrip', 'bluray', 'brrip', 'bdrip', 'hdrip', 'hdtv', 'tvrip',
  'dvdrip', 'dvdscr', 'cam', 'ts', 'hdts', 'remux', 'rip', 'screener',
  // codec / container
  'x264', 'x265', 'h264', 'h265', 'hevc', 'avc', 'xvid', 'divx', 'av1', 'vc1',
  'mkv', 'mp4', 'avi', 'mov', 'mpeg',
  // audio
  'aac', 'ac3', 'dts', 'mp3', 'flac', 'opus', 'eac3', 'ddp', 'ddp51', 'truehd', 'atmos',
  // streaming source
  'amzn', 'nf', 'netflix', 'atvp', 'dsnp', 'max', 'hmax', 'pcok', 'hulu', 'pmtp', 'stan', 'stz',
  // marker IT di release
  'mux', 'mircrew', 'novarip', 'dlmux', 'darksideMux', 'darkside', 'mdshd', 'ispa',
  'icv', 'crew', 'pir8', 'italmux', 'imux', 'iso', 'md',
  // altri comuni
  'complete', 'season', 'stagione', 'pack', 'collection', 'series', 'serie',
]);

function titleMatchesSeriesStrict(torrentName, meta) {
  if (!titleMatches(torrentName, meta, { checkYear: false })) return false;
  const metaTokens = new Set(significantWords(meta.title));
  const SHOW_STOPWORDS = new Set(['the', 'a', 'an', 'of', 'and', 'or', 'di', 'la', 'il', 'lo', 'le', 'i', 'gli', 'un', 'una', 'e', 'to', 'in', 'on', 'at', 'by']);
  const showPart = showPortion(torrentName);
  const showTokens = normalize(showPart)
    .split(' ')
    .filter((w) => w && w.length >= 2 && !SHOW_STOPWORDS.has(w));
  for (const w of showTokens) {
    if (/^(19|20)\d{2}$/.test(w)) continue;          // anno OK
    if (metaTokens.has(w)) continue;                  // parola del titolo OK
    if (RELEASE_NOISE_TOKENS.has(w)) continue;        // ITA, 1080p, x264, ecc. OK
    if (w.length <= 3 && /^[a-z]+$/.test(w)) return false; // sigla extra (svu, ci, uk) → spinoff
    return false; // parola intera extra (Toronto, Vigilantes, ecc.) → spinoff
  }
  return true;
}

function formatSize(bytes) {
  if (!bytes || isNaN(bytes)) return null;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let n = Number(bytes);
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n < 10 ? 2 : 1)} ${units[i]}`;
}

// Pattern sub-ita: "Sub Ita", "Sub.Ita", "Subs Ita", "NUita" (Sp33dy94), "Multisub"
const SUBITA_RE = /\b(sub[s]?[.\s\-_]?ita|sub[s]?[.\s\-_]?italian|nu[.\-_]?ita|multi[.\-_]?subs?)\b/gi;
// Pattern audio ita: "ITA", "iTALiAN", "Italiano" (no quelli "Sub Ita")
const AUDIO_ITA_RE = /\b(ita|italian|italiano|iTALiAN)\b/i;

// Rileva audio ITA dopo aver rimosso le occorrenze di "sub ita".
function isItalian(name) {
  if (!name) return false;
  const cleaned = name.replace(SUBITA_RE, ' ');
  return AUDIO_ITA_RE.test(cleaned);
}

// Rileva sub-ita esplicito SENZA audio italiano.
function hasItalianSub(name) {
  if (!name) return false;
  if (!SUBITA_RE.test(name)) return false;
  // Re-test isItalian per assicurarmi che non sia anche audio ITA
  const cleaned = name.replace(SUBITA_RE, ' ');
  return !AUDIO_ITA_RE.test(cleaned);
}

// === Detection EN (mirror della logica ITA, usato solo se config.lang='en') ===
// Pattern audio ENG: token espliciti "eng/english", source US (NF/AMZN/ATVP),
// release groups noti per audio EN originale (RARBG, YIFY, GalaxyRG, ecc.),
// dub explicit. Falso negativo accettato (no marker = "non sappiamo, escluso").
const AUDIO_ENG_RE = /\b(?:eng|english|ENG|EN[- ]?DUB|english[- ]?dub|en\.dub|amzn|atvp|netflix|nf\b|max|hmax|hbo|dsnp|disney\+?|hulu|paramount\+?|peacock|crunchyroll dub|funimation|crunchyroll\.com)\b/i;
const SUBENG_RE = /\b(?:sub[\s.\-_]?eng|sub[\s.\-_]?english|ENG[\s.\-_]?SUB|english[\s.\-_]?sub|softsub[\s.\-_]?eng|hardsub[\s.\-_]?eng|\beng\s?subs?\b)\b/i;

function isEnglish(name) {
  if (!name) return false;
  // Esclude sub-eng prima di testare audio
  const cleaned = name.replace(SUBENG_RE, ' ');
  // Se c'è "ITA" o "italian" prominente, probabilmente non è audio EN principale
  // (multi-audio releases vengono comunque catturati da sub-eng o detection ITA loro).
  if (/\b(?:ita\s+audio|audio[\s.\-_]?ita|italian[\s.\-_]?audio|dub[\s.\-_]?ita)\b/i.test(cleaned)) return false;
  return AUDIO_ENG_RE.test(cleaned);
}

function hasEnglishSub(name) {
  if (!name) return false;
  if (!SUBENG_RE.test(name)) return false;
  const cleaned = name.replace(SUBENG_RE, ' ');
  return !AUDIO_ENG_RE.test(cleaned);
}

// SPECIFICO PER ANIME (non per film): release group VERIFICATI multi-sub con ITA.
// Lista stretta — molti gruppi (SubsPlease, BILI, Crunchyroll standalone, HiDive)
// in realtà rilasciano SOLO subs inglesi → falsi positivi se inclusi qui.
// Verificati ITA-presente: Erai-raws (multi-sub esplicito), ToonsHub, ASW.
const ANIME_MULTISUB_GROUPS = /\b(erai-raws|toonshub|asw|aswsubs)\b/i;
const ANIME_DUB_ONLY = /\b(english dub|funi(?:mation)? dub|kayoanime|english.?only|en[- ]dub)\b/i;

function animeProbablyHasItaSub(name) {
  if (!name) return false;
  if (ANIME_DUB_ONLY.test(name)) return false;
  return ANIME_MULTISUB_GROUPS.test(name);
}

// SPECIFICO PER SERIE TV: pattern che suggeriscono presenza di sub ITA anche senza
// tag espliciti "Sub Ita".
// - Lista di language code che include 'ita' (es. "[ENG SPA ITA POR FRA]")
// - Source streaming originale ITA (NF/AMZN/ATVP/DSNP/MAX/HMAX WEB-DL): le release
//   ufficiali da queste piattaforme includono quasi sempre i sub italiani perché
//   distribuiti anche in Italia.
const LANG_CODES_RE = /\b(eng|fra|fre|ger|deu|spa|por|jpn|rus|chi|kor|cze|pol|dan|swe|nor|fin|hun|tur|ara|hin|tha|vie|ind|nld|dut|gre|heb|ron|ukr|bul|hrv|srp|slk|slv|cat|lat)\b/gi;
const ITA_IN_LANGLIST_RE = /\bita\b/i;
const STREAMING_SOURCE_RE = /\b(nf|amzn|atvp|dsnp|max|hmax|hulu|pcok|pmtp|stan|stz)[\s._\-]?web[- ]?(dl|rip)?\b/i;

function seriesProbablyHasItaSub(name) {
  if (!name) return false;
  // 1) Lista di language code (>= 2 lingue) con 'ita' tra esse
  const langs = (name.match(LANG_CODES_RE) || []);
  if (langs.length >= 2 && ITA_IN_LANGLIST_RE.test(name)) return true;
  // 2) Source streaming originale (NF/AMZN/ATVP/DSNP/...) — release ufficiali
  //    distribuite in Italia includono i sub italiani.
  if (STREAMING_SOURCE_RE.test(name)) return true;
  return false;
}

function matchesEpisode(name, season, episode) {
  if (!season || !episode) return true;
  const s = String(season).padStart(2, '0');
  const e = String(episode).padStart(2, '0');
  const patterns = [
    new RegExp(`s${s}e${e}`, 'i'),
    new RegExp(`${season}x${e}`, 'i'),
    new RegExp(`season[ ._-]?${season}.*episode[ ._-]?${episode}`, 'i'),
  ];
  return patterns.some((p) => p.test(name));
}

function isSeasonPack(name, season) {
  if (!name) return false;
  const s = String(season).padStart(2, '0');
  const patterns = [
    new RegExp(`s${s}\\b(?!e\\d)`, 'i'),
    new RegExp(`season[ ._-]?${season}\\b(?!.*episode)`, 'i'),
    new RegExp(`stagione[ ._-]?${season}\\b`, 'i'),
    new RegExp(`complete`, 'i'),
  ];
  return patterns.some((p) => p.test(name));
}

// === FILTRI SPECIFICI ANIME ===
// Parole che, se compaiono nel torrent name dopo il titolo, indicano un'opera DIVERSA
// dalla serie principale (spinoff / film / OAV / recap). Servono a evitare che
// "My Hero Academia Vigilantes" arrivi tra i risultati di "My Hero Academia".
const ANIME_SPINOFF_KEYWORDS = [
  'vigilantes', 'movie', 'film', 'ova', 'oad', 'oav', 'special', 'specials',
  'recap', 'pilot', 'rebellion', 'redo of healer',
  // Categorie spurie comuni nei torrent
];

function titleMatchesAnimeStrict(torrentName, meta) {
  const norm = normalize(torrentName);
  const titleNorm = normalize(meta.title);
  // 1) Tutte le parole significative del titolo principale devono comparire
  const words = significantWords(meta.title);
  for (const w of words) {
    const re = new RegExp(`(?:^|[^a-z0-9])${escapeRe(w)}(?:$|[^a-z0-9])`, 'i');
    if (!re.test(norm)) return false;
  }
  // 2) Costruisco il "resto" del nome dopo aver rimosso il titolo: se contiene
  // una keyword spinoff è un'altra opera (es. Vigilantes, Movie, OVA).
  // Sostituisco il titolo (qualsiasi separatore tra le parole) con uno spazio.
  const titlePattern = words.map(escapeRe).join('[\\s._\\-]+');
  const afterTitle = norm.replace(new RegExp(titlePattern, 'i'), ' ');
  for (const kw of ANIME_SPINOFF_KEYWORDS) {
    const reKw = new RegExp(`(?:^|[^a-z0-9])${escapeRe(kw)}(?:$|[^a-z0-9])`, 'i');
    if (reKw.test(afterTitle)) return false;
  }
  return true;
}

// Match preciso di episodio anime. Accetta:
// - SxxExx con padding flessibile (S03E02, S3E2, S3 - 02)
// - NxNN (3x02, 3x2)
// - absolute episode (es. "- 40 [", "- 40)") solo se NO SxxExx con altri valori
function matchesAnimeEpisode(torrentName, season, episode, absoluteEpisode) {
  if (!season || !episode) return true;
  const tn = torrentName;
  const s = String(season);
  const e = String(episode);

  // SxxExx flessibile + convenzioni anime tipo "6th Season - 16"
  const stdPatterns = [
    new RegExp(`\\bs0?${s}\\s*e0?${e}\\b`, 'i'),                  // S3E2, S03E02
    new RegExp(`\\bs0?${s}\\b[^a-z0-9]{1,4}0?${e}\\b(?!\\d)`, 'i'),// S3 - 02
    new RegExp(`\\b${s}x0?${e}\\b`, 'i'),                          // 3x02
    new RegExp(`\\bseason[\\s._\\-]?${s}.*episode[\\s._\\-]?${e}\\b`, 'i'),
    // "6th Season - 16" / "3rd Season - 02"
    new RegExp(`\\b${s}(?:st|nd|rd|th)\\s+season[\\s\\-_.]+0?${e}\\b(?!\\d)`, 'i'),
  ];
  if (stdPatterns.some((p) => p.test(tn))) return true;

  // Absolute episode: match ESATTO (no tolleranza ±1).
  // L'offset eventuale è già applicato in cinemeta.js (es. One Piece +1).
  if (absoluteEpisode && absoluteEpisode !== episode) {
    const variants = [
      String(absoluteEpisode),
      String(absoluteEpisode).padStart(2, '0'),
      String(absoluteEpisode).padStart(3, '0'),
    ].filter((v, i, a) => a.indexOf(v) === i);
    // " - 1163 [" / " - 40 (" — convenzione anime
    const absRe = new RegExp(
      `\\s-\\s(?:${variants.join('|')})(?=[\\s\\.\\-_\\[\\]\\)v]|$)`,
      ''
    );
    const conflictRe = new RegExp(`\\bs(\\d{1,2})\\s*e\\d{1,2}\\b`, 'i');
    const m = tn.match(conflictRe);
    if (m && parseInt(m[1], 10) !== season) return false;
    if (absRe.test(tn)) return true;
    // VARYG: "S01E1163" (tutto piatto su S1)
    if (new RegExp(`\\bs0?1e0?(?:${variants.join('|')})\\b`, 'i').test(tn)) return true;
    // ToonsHub: "EP1163"
    if (new RegExp(`\\bep0?(?:${variants.join('|')})\\b`, 'i').test(tn)) return true;
  }

  // Esplicito rifiuto pack: "Seasons X to Y", "Complete", "Stagione N" (senza ep)
  if (/\bseasons?\s*\d+\s*to\s*\d+\b/i.test(tn)) return false;
  if (/\bcomplete\b/i.test(tn) && !/\bs0?\d+e0?\d+\b/i.test(tn)) return false;

  return false;
}

// Trova il file dentro un pack che corrisponde all'episodio richiesto.
// `files` è un array con almeno {name|short_name|path, size}. Restituisce
// l'oggetto file o null se non trovato.
function findFileForEpisode(files, season, episode, absoluteEpisode = null) {
  if (!Array.isArray(files) || !season || !episode) return null;
  const videoRe = /\.(mkv|mp4|avi|mov|webm|m4v|ts)$/i;
  const sStr = String(season);
  const eStr = String(episode);
  // Pattern: S05E03, s5e3, S05.E03, 5x03, "5 03", "Season 5 ep 3"
  const patterns = [
    new RegExp(`\\bs0?${sStr}[\\s._\\-]*e0?${eStr}\\b`, 'i'),
    new RegExp(`\\b${sStr}x0?${eStr}\\b`, 'i'),
    new RegExp(`\\bseason[\\s._\\-]?${sStr}[\\s._\\-]*(?:episode|ep|e)[\\s._\\-]?${eStr}\\b`, 'i'),
    new RegExp(`\\bs0?${sStr}\\b[^a-z0-9]{1,4}0?${eStr}\\b(?!\\d)`, 'i'),
  ];
  const candidates = files
    .map((f) => ({ f, name: f.name || f.short_name || f.path || '' }))
    .filter((x) => x.name && videoRe.test(x.name));
  for (const re of patterns) {
    const match = candidates.find((x) => re.test(x.name));
    if (match) return match.f;
  }
  // ANIME FALLBACK — match numerazione assoluta dentro al filename.
  // Trigger automatico per casi Kitsu flat (season=1, episode>=30 = quasi
  // sicuramente absolute), oppure se il caller passa absoluteEpisode esplicito.
  // Pattern coperti: "One Piece - 1163.mkv", "Naruto_220_END", "[Group] Anime 100 [...]"
  const absNum = absoluteEpisode != null
    ? Number(absoluteEpisode)
    : (Number(season) === 1 && Number(episode) >= 30 ? Number(episode) : null);
  if (absNum && absNum > 0) {
    const a = String(absNum);
    const a3 = a.padStart(3, '0');
    const absPatterns = [
      new RegExp(`[\\s\\-._\\[(]0?${a}[\\s\\-._\\])]`, 'i'),
      new RegExp(`[\\s\\-._\\[(]${a3}[\\s\\-._\\])]`, 'i'),
      new RegExp(`\\b(?:ep|episode|#)[\\s._\\-]*0?${a}\\b(?!\\d)`, 'i'),
    ];
    for (const re of absPatterns) {
      const match = candidates.find((x) => re.test(x.name));
      if (match) return match.f;
    }
  }
  return null;
}

module.exports = {
  parseQuality, formatSize, matchesEpisode, isItalian, hasItalianSub,
  isEnglish, hasEnglishSub,
  animeProbablyHasItaSub, seriesProbablyHasItaSub,
  isSeasonPack, isHDR, titleMatches, titleMatchesSeriesStrict,
  titleMatchesAnimeStrict, matchesAnimeEpisode,
  findFileForEpisode,
};
