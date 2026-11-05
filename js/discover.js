// Découverte : mix du jour, radio d'artiste, humeurs, notes et journal d'écoute.
// Tout est calculé dans le téléphone à partir de la bibliothèque et des écoutes.

const DAY = 86400000;

/** Générateur pseudo-aléatoire reproductible : le même jour donne le même mix. */
export function seeded(seed) {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const dayKey = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const hash = (s) => [...s].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0, 7);

/** Mélange en évitant deux morceaux du même artiste à la suite quand c'est possible. */
export function spreadArtists(tracks, random = Math.random) {
  const pool = [...tracks];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const out = [];
  while (pool.length) {
    const last = out[out.length - 1]?.artist;
    const index = pool.findIndex((t) => t.artist !== last);
    out.push(pool.splice(index === -1 ? 0 : index, 1)[0]);
  }
  return out;
}

/**
 * Mix du jour : surtout des morceaux aimés (favoris, notes, écoutes), des retrouvailles
 * avec ce qu'on n'a pas écouté depuis longtemps, et quelques morceaux jamais écoutés.
 */
export function dailyMix(tracks, date = new Date(), size = 25) {
  if (tracks.length < 8) return [];
  const random = seeded(hash(dayKey(date)));
  const now = date.getTime();
  const love = (t) => Math.log1p(t.plays || 0) + (t.fav ? 1.5 : 0) + (t.rating || 0) * 0.45 + random() * 1.6
    - (t.lastPlayed && now - t.lastPlayed < DAY / 2 ? 1.2 : 0);
  const scored = tracks.map((t) => ({ t, s: love(t) })).sort((a, b) => b.s - a.s);
  const n = Math.min(size, tracks.length);
  const picked = new Set();
  const take = (list, count) => {
    for (const t of list) {
      if (picked.size >= n || count <= 0) break;
      if (!picked.has(t)) {
        picked.add(t);
        count -= 1;
      }
    }
  };
  const rediscover = tracks.filter((t) => t.plays > 0 && now - (t.lastPlayed || 0) > 14 * DAY).sort(() => random() - 0.5);
  const fresh = tracks.filter((t) => !t.plays).sort(() => random() - 0.5);
  take(rediscover, Math.round(n * 0.25));
  take(fresh, Math.round(n * 0.15));
  take(scored.map((x) => x.t), n);
  return spreadArtists([...picked], random);
}

const artistsOf = (track) => String(track.artist || '').split(/\s*(?:,|&|\bfeat\.?|\bft\.?|\bx\b|;)\s*/i).map((s) => s.trim()).filter(Boolean);
const lower = (s) => s.toLocaleLowerCase('fr').normalize('NFD').replace(/\p{M}/gu, '');

/** Artistes proches : featurings, mêmes playlists, mêmes albums, écoutés les mêmes mois. */
export function relatedArtists(artist, tracks, playlists = [], stats = { months: {} }) {
  const me = lower(artist);
  const score = new Map();
  const add = (name, points) => {
    const key = lower(name);
    if (!key || key === me || key === 'artiste inconnu') return;
    score.set(name, (score.get(name) || 0) + points);
  };
  const mine = tracks.filter((t) => artistsOf(t).some((a) => lower(a) === me));
  const mineIds = new Set(mine.map((t) => t.id));
  for (const t of tracks) {
    const title = lower(t.title || '');
    const names = artistsOf(t);
    const withMe = names.some((a) => lower(a) === me);
    // Featuring : « X feat. Werenoi » ou un artiste cité dans le titre.
    if (withMe) names.forEach((a) => add(a, 3));
    else if (title.includes(me) && me.length > 2) names.forEach((a) => add(a, 3));
  }
  for (const t of mine) {
    const title = lower(t.title || '');
    for (const other of tracks) {
      const name = artistsOf(other)[0];
      if (name && name.length > 2 && title.includes(lower(name))) add(name, 3);
    }
  }
  const albums = new Set(mine.map((t) => lower(t.album || '')).filter(Boolean));
  for (const t of tracks) if (!mineIds.has(t.id) && albums.has(lower(t.album || ''))) add(artistsOf(t)[0] || t.artist, 1);
  for (const p of playlists) {
    const ids = new Set(p.trackIds);
    if (![...mineIds].some((id) => ids.has(id))) continue;
    const seen = new Set();
    for (const t of tracks) if (ids.has(t.id) && !mineIds.has(t.id)) seen.add(t.artist);
    seen.forEach((a) => add(a, 1));
  }
  for (const month of Object.values(stats.months || {})) {
    const listened = Object.entries(month.artists || {}).filter(([, s]) => s >= 120).map(([a]) => a);
    if (!listened.some((a) => lower(a) === me)) continue;
    listened.forEach((a) => add(a, 0.5));
  }
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([name, points]) => ({ name, points }));
}

/** Radio d'artiste : ses morceaux mêlés à ceux des artistes proches (ou aux morceaux préférés). */
export function artistRadio(artist, tracks, playlists = [], stats = { months: {} }, random = Math.random, size = 40) {
  const me = lower(artist);
  const mine = tracks.filter((t) => artistsOf(t).some((a) => lower(a) === me));
  if (!mine.length) return [];
  const related = relatedArtists(artist, tracks, playlists, stats).slice(0, 8);
  const relatedNames = new Set(related.map((r) => lower(r.name)));
  let others = tracks.filter((t) => !mine.includes(t) && artistsOf(t).some((a) => relatedNames.has(lower(a))));
  if (others.length < 6) {
    // Peu de liens connus : on complète avec les morceaux les plus aimés.
    const loved = tracks.filter((t) => !mine.includes(t) && !others.includes(t))
      .sort((a, b) => (b.fav ? 2 : 0) + (b.rating || 0) + Math.log1p(b.plays || 0) - ((a.fav ? 2 : 0) + (a.rating || 0) + Math.log1p(a.plays || 0)));
    others = [...others, ...loved.slice(0, 12)];
  }
  const shuffle = (list) => list.map((t) => [random(), t]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
  const a = shuffle(mine);
  const b = shuffle(others);
  const out = [];
  // Environ deux morceaux de l'artiste pour un d'un proche.
  while (out.length < size && (a.length || b.length)) {
    if (a.length) out.push(a.shift());
    if (a.length && out.length < size && random() < 0.5) out.push(a.shift());
    if (b.length && out.length < size) out.push(b.shift());
  }
  return out;
}

// MARK: Humeurs et notes

export const MOODS = [
  { id: 'chill', name: 'Chill', hue: 190 },
  { id: 'sport', name: 'Sport', hue: 10 },
  { id: 'soiree', name: 'Soirée', hue: 300 },
  { id: 'love', name: 'Love', hue: 340 },
  { id: 'melancolie', name: 'Mélancolie', hue: 230 },
  { id: 'focus', name: 'Concentration', hue: 150 },
  { id: 'route', name: 'En voiture', hue: 35 },
  { id: 'motivation', name: 'Motivation', hue: 55 },
];

export const moodTracks = (id, tracks) => tracks.filter((t) => t.moods?.includes(id));

export function usedMoods(tracks) {
  return MOODS.map((m) => ({ ...m, count: moodTracks(m.id, tracks).length })).filter((m) => m.count > 0);
}

export const topRated = (tracks) => tracks.filter((t) => t.rating >= 4).sort((a, b) => b.rating - a.rating || (b.plays || 0) - (a.plays || 0));

// MARK: Journal d'écoute

const HISTORY = 'uhqsic.history';
const HISTORY_MAX = 3000;

export function loadHistory(storage = globalThis.localStorage) {
  try {
    return JSON.parse(storage?.getItem(HISTORY) || '[]');
  } catch {
    return [];
  }
}

export function addHistory(history, id, at = Date.now(), storage = globalThis.localStorage) {
  history.push([id, at]);
  if (history.length > HISTORY_MAX) history.splice(0, history.length - HISTORY_MAX);
  try {
    storage?.setItem(HISTORY, JSON.stringify(history));
  } catch {
    // Stockage plein : le journal garde ce qu'il a.
  }
  return history;
}

/** Journal regroupé par jour, du plus récent au plus ancien. */
export function historyByDay(history, exists = () => true, now = new Date()) {
  const days = new Map();
  for (let i = history.length - 1; i >= 0; i--) {
    const [id, at] = history[i];
    if (!exists(id)) continue;
    const key = dayKey(new Date(at));
    if (!days.has(key)) days.set(key, { key, label: dayLabel(new Date(at), now), entries: [] });
    days.get(key).entries.push({ id, at });
  }
  return [...days.values()];
}

export function dayLabel(date, now = new Date()) {
  const start = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((start(now) - start(date)) / DAY);
  if (diff === 0) return 'Aujourd\'hui';
  if (diff === 1) return 'Hier';
  const label = date.toLocaleDateString('fr', { weekday: 'long', day: 'numeric', month: 'long', ...(date.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
  return label.charAt(0).toUpperCase() + label.slice(1);
}
