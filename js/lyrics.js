// Recherche de paroles, sans clé ni compte, depuis le téléphone :
// 1. LRCLIB (base ouverte, paroles synchronisées), avec des titres nettoyés ;
// 2. le catalogue Deezer (via lyrics.ovh) pour retrouver le vrai nom d'un morceau mal nommé,
//    puis LRCLIB et lyrics.ovh avec ce nom.
// Seuls le titre, l'artiste et la durée sont envoyés.

const LRCLIB = 'https://lrclib.net/api';
const OVH = 'https://api.lyrics.ovh';
const UNKNOWN = 'Artiste inconnu';

/** « [01:02.50] texte » → [{ time: 62.5, text: 'texte' }], triées, métadonnées ignorées. */
export function parseLRC(lrc) {
  const lines = [];
  for (const raw of (lrc || '').split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
    if (!stamps.length) continue;
    const text = raw.replace(/\[[^\]]*\]/g, '').trim();
    for (const [, m, s, frac = '0'] of stamps) {
      lines.push({ time: Number(m) * 60 + Number(s) + Number(`0.${frac}`), text });
    }
  }
  return lines.sort((a, b) => a.time - b.time);
}

/** Index de la ligne en cours à l'instant `time` (-1 avant la première). */
export function currentLine(lines, time) {
  let lo = 0;
  let hi = lines.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].time <= time + 0.15) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

export function normalize(s) {
  return (s || '').toLocaleLowerCase('fr').normalize('NFD').replace(/\p{M}/gu, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

// Ce qui encombre les titres venus de YouTube ou des plateformes, sans rien dire du morceau.
const NOISE = /\b(clip|officiel+e?|official|video|vid[ée]o|visuali[sz]er|audio|lyrics?|paroles?|lyric video|music video|hd|hq|4k|remaster(ed)?( \d{4})?|explicit|prod\.?|freestyle video|en live|live session)\b/i;

/** « Werenoi - Solitaire (Clip Officiel) [feat. X] » → « Solitaire ». */
export function cleanTitle(title, artist = '') {
  let t = String(title || '').replace(/_/g, ' ').replace(/\.(mp3|m4a|flac|wav|aac)$/i, '');
  // Parenthèses et crochets qui ne parlent pas du morceau (clip, audio, feat…).
  t = t.replace(/[([【]([^)\]】]*)[)\]】]/g, (whole, inside) => (NOISE.test(inside) || /\b(feat|ft|featuring|avec|with)\b/i.test(inside) ? ' ' : whole));
  t = t.replace(/\s+(feat\.?|ft\.?|featuring)\s.+$/i, '');
  // Artiste en tête ou en fin de titre : « Werenoi - Malus », « Alpha - werenoi ».
  const parts = t.split(/\s+[-–—|]\s+/);
  if (parts.length > 1 && artist) {
    const a = normalize(artist);
    const kept = parts.filter((p) => normalize(p) !== a && !(a && normalize(p).startsWith(`${a} `) && normalize(p).split(' ').length <= a.split(' ').length + 1));
    if (kept.length && kept.length < parts.length) t = kept.join(' - ');
  }
  t = t.replace(/\s{2,}/g, ' ').replace(/^[\s\-–—|:]+|[\s\-–—|:]+$/g, '').trim();
  return t || String(title || '').trim();
}

/** Artiste et titre d'un morceau, même quand l'artiste n'est que dans le titre (« Lagui - Capo »). */
export function identity({ title, artist }) {
  let a = artist && artist !== UNKNOWN ? artist.trim() : '';
  let t = String(title || '');
  if (!a) {
    const parts = t.split(/\s+[-–—]\s+/);
    if (parts.length >= 2) {
      a = parts[0].trim();
      t = parts.slice(1).join(' - ');
    }
  }
  // « KLM feat. Gazo » : l'artiste principal suffit pour chercher.
  const main = a.split(/\s*(?:,|&|\bfeat\.?|\bft\.?|\bx\b|;)\s*/i)[0].trim() || a;
  return { title: cleanTitle(t, main), artist: main };
}

function similarity(a, b) {
  const grams = (s) => {
    const t = normalize(s).replace(/ /g, '');
    const map = new Map();
    for (let i = 0; i < t.length - 1; i++) map.set(t.slice(i, i + 2), (map.get(t.slice(i, i + 2)) || 0) + 1);
    return [map, Math.max(t.length - 1, 0), t];
  };
  const [A, na, ta] = grams(a);
  const [B, nb, tb] = grams(b);
  if (ta && ta === tb) return 1;
  if (!na || !nb) return 0;
  let common = 0;
  for (const [g, n] of A) common += Math.min(n, B.get(g) || 0);
  return (2 * common) / (na + nb);
}

/** Les artistes d'un résultat (« Gazo, KLM ») comparés un par un. */
function artistSimilarity(wanted, found) {
  const names = String(found || '').split(/\s*(?:,|&|\bfeat\.?|\bft\.?|\bx\b|;|\/)\s*/i).filter(Boolean);
  return Math.max(similarity(wanted, found), ...names.map((n) => similarity(wanted, n)));
}

/** Choisit le meilleur résultat : titre et artiste ressemblants, durée proche, synchronisé de préférence. */
export function pickBest(results, { title, artist, duration }) {
  const knownArtist = artist && artist !== UNKNOWN;
  let best = null;
  let bestScore = 0;
  for (const r of results || []) {
    if (!r.plainLyrics && !r.syncedLyrics && !r.instrumental) continue;
    const resultTitle = cleanTitle(r.trackName, r.artistName);
    let score = Math.max(similarity(title, resultTitle), similarity(title, r.trackName) * 0.95) * 0.6;
    score += knownArtist ? artistSimilarity(artist, r.artistName) * 0.3 : 0.15;
    // Paroles synchronisées d'une autre version (clip avec intro, radio edit…) : toutes les lignes
    // tomberaient à côté. La durée doit donc être très proche.
    const diff = duration > 0 && r.duration > 0 ? Math.abs(duration - r.duration) : null;
    if (diff !== null) score += diff <= 2 ? 0.2 : diff <= 4 ? 0.12 : diff <= 8 ? 0 : diff <= 20 ? -0.12 : -0.25;
    if (r.syncedLyrics && (diff === null || diff <= 4)) score += 0.05;
    if (score > bestScore) {
      best = r;
      bestScore = score;
    }
  }
  return bestScore >= 0.55 ? best : null;
}

async function getJSON(url, retry = true) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9000);
  let response;
  try {
    response = await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
  if (response.status === 404) return null;
  if (!response.ok) {
    // Un hoquet du serveur (429, 5xx) est réessayé une fois.
    if (retry && (response.status === 429 || response.status >= 500)) {
      await new Promise((r) => setTimeout(r, 1200));
      return getJSON(url, false);
    }
    throw new Error('reseau');
  }
  return response.json();
}

const q = (params) => new URLSearchParams(params).toString();

/** Nom exact d'un morceau d'après le catalogue Deezer (utile quand le fichier est mal nommé). */
async function catalogMatch({ title, artist, duration }) {
  const data = await getJSON(`${OVH}/suggest/${encodeURIComponent(`${artist} ${title}`.trim())}`);
  let best = null;
  let bestScore = 0;
  for (const d of data?.data || []) {
    let score = similarity(title, cleanTitle(d.title_short || d.title, d.artist?.name)) * 0.6;
    score += artist ? artistSimilarity(artist, d.artist?.name) * 0.3 : 0.15;
    if (duration > 0 && d.duration > 0) score += Math.abs(duration - d.duration) <= 4 ? 0.15 : Math.abs(duration - d.duration) > 30 ? -0.2 : 0;
    if (score > bestScore) {
      best = d;
      bestScore = score;
    }
  }
  return bestScore >= 0.6 ? { title: best.title_short || best.title, artist: best.artist?.name || artist, duration: best.duration } : null;
}

/** Cherche les paroles d'un morceau. `null` si introuvables ; lève une erreur si pas de réseau. */
export async function findLyrics(track) {
  const id = identity(track);
  const duration = Math.round(track.duration || 0);
  const wanted = { ...id, duration };
  const steps = [];
  if (id.artist && duration) steps.push(async () => exact(await getJSON(`${LRCLIB}/get?${q({ track_name: id.title, artist_name: id.artist, duration })}`)));
  if (id.artist) {
    steps.push(async () => pickBest(await getJSON(`${LRCLIB}/search?${q({ track_name: id.title, artist_name: id.artist })}`), wanted));
    steps.push(async () => pickBest(await getJSON(`${LRCLIB}/search?${q({ q: `${id.artist} ${id.title}` })}`), wanted));
  }
  steps.push(async () => pickBest(await getJSON(`${LRCLIB}/search?${q({ q: id.title })}`), wanted));
  // Dernier recours : le vrai nom du morceau, puis LRCLIB et lyrics.ovh avec ce nom.
  steps.push(async () => {
    const real = await catalogMatch(wanted);
    if (!real) return null;
    const synced = exact(await getJSON(`${LRCLIB}/get?${q({ track_name: real.title, artist_name: real.artist, duration: real.duration || duration })}`).catch(() => null))
      || pickBest(await getJSON(`${LRCLIB}/search?${q({ track_name: real.title, artist_name: real.artist })}`).catch(() => null), { ...real, duration });
    if (synced) return synced;
    const plain = await getJSON(`${OVH}/v1/${encodeURIComponent(real.artist)}/${encodeURIComponent(real.title)}`);
    return plain?.lyrics?.trim() ? { plainLyrics: plain.lyrics.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim(), source: 'lyrics.ovh' } : null;
  });

  // Une étape en échec n'empêche pas les suivantes ; l'erreur ne remonte que si toutes échouent.
  // Un résultat sans synchronisation est gardé de côté le temps de chercher une version synchronisée.
  let failures = 0;
  let textOnly = null;
  for (const step of steps) {
    try {
      const found = await step();
      if (found?.syncedLyrics || (found?.instrumental && !found.plainLyrics)) return toLyrics(found);
      if (found) {
        textOnly ??= found;
        if (steps.indexOf(step) >= 2) break;
      }
    } catch {
      failures += 1;
    }
  }
  if (textOnly) return toLyrics(textOnly);
  if (failures === steps.length) throw new Error('reseau');
  return null;
}

const exact = (data) => (data && (data.syncedLyrics || data.plainLyrics || data.instrumental) ? data : null);

/** Résultats bruts d'une recherche libre, pour choisir soi-même les bonnes paroles. */
export async function searchLyricsCandidates(text, duration = 0) {
  const data = await getJSON(`${LRCLIB}/search?${q({ q: text })}`);
  const seen = new Set();
  return (data || [])
    .filter((r) => r.plainLyrics || r.syncedLyrics || r.instrumental)
    .sort((a, b) => {
      // Même durée que le fichier d'abord : ce sont les seules dont la synchro tombe juste.
      const close = (r) => (duration > 0 && r.duration > 0 && Math.abs(duration - r.duration) <= 3 ? 1 : 0);
      return close(b) - close(a) || Number(!!b.syncedLyrics) - Number(!!a.syncedLyrics);
    })
    .filter((r) => {
      const key = `${normalize(r.artistName)}|${normalize(cleanTitle(r.trackName, r.artistName))}|${Math.round((r.duration || 0) / 5)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 25)
    .map((r) => ({ title: cleanTitle(r.trackName, r.artistName), artist: r.artistName, duration: r.duration, sameLength: duration > 0 && r.duration > 0 && Math.abs(duration - r.duration) <= 3, synced: !!r.syncedLyrics, lyrics: toLyrics(r) }));
}

export function toLyrics(r) {
  const plain = (r.plainLyrics || parseLRC(r.syncedLyrics).map((l) => l.text).join('\n')).trim();
  return { plain, synced: r.syncedLyrics || '', instrumental: !!r.instrumental && !plain, source: r.source || 'LRCLIB', length: Math.round(r.duration || 0) };
}
