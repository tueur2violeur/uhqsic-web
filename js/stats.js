// Statistiques d'écoute : temps écouté par mois, par artiste et par morceau.
// Tout reste dans le téléphone (localStorage), rien n'est envoyé.

const KEY = 'uhqsic.stats';
export const PLAY_THRESHOLD = 30; // secondes (ou la moitié d'un morceau court) pour compter une écoute

export const monthKey = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;

export function loadStats(storage = globalThis.localStorage) {
  try {
    return JSON.parse(storage?.getItem(KEY) || 'null') || { months: {} };
  } catch {
    return { months: {} };
  }
}

export function saveStats(stats, storage = globalThis.localStorage) {
  try {
    storage?.setItem(KEY, JSON.stringify(stats));
  } catch {
    // Stockage plein : on garde les statistiques en mémoire pour la session.
  }
}

/** Ajoute du temps d'écoute réel au mois en cours. */
export function addListening(stats, track, seconds, date = new Date()) {
  if (!(seconds > 0) || !track) return stats;
  const month = (stats.months[monthKey(date)] ??= { seconds: 0, artists: {}, tracks: {} });
  month.seconds += seconds;
  month.artists[track.artist] = (month.artists[track.artist] || 0) + seconds;
  month.tracks[track.id] = (month.tracks[track.id] || 0) + seconds;
  return stats;
}

/** Récap d'un mois : temps total, artistes et morceaux les plus écoutés. */
export function recap(stats, key = monthKey()) {
  const month = stats.months[key];
  if (!month || month.seconds < 60) return null;
  // Moins d'une minute ne fait pas un classement.
  const top = (map, n) => Object.entries(map).filter(([, seconds]) => seconds >= 60).sort((a, b) => b[1] - a[1]).slice(0, n);
  return {
    key,
    minutes: Math.round(month.seconds / 60),
    artists: top(month.artists, 5).map(([name, seconds]) => ({ name, minutes: Math.round(seconds / 60) })),
    tracks: top(month.tracks, 5).map(([id, seconds]) => ({ id, minutes: Math.round(seconds / 60) })),
  };
}

export function monthName(key) {
  const [year, month] = key.split('-').map(Number);
  return new Date(year, month - 1, 1).toLocaleDateString('fr', { month: 'long', year: 'numeric' });
}

// MARK: Playlists automatiques

const DAY = 86400000;

export const SMART = [
  { id: 'top', name: 'Les plus écoutés', pick: (tracks) => tracks.filter((t) => t.plays > 0).sort((a, b) => b.plays - a.plays || (b.lastPlayed || 0) - (a.lastPlayed || 0)).slice(0, 25) },
  { id: 'recent', name: 'Ajoutés cette semaine', pick: (tracks, now) => tracks.filter((t) => now - (t.addedAt || 0) < 7 * DAY).sort((a, b) => b.addedAt - a.addedAt) },
  { id: 'never', name: 'Jamais écoutés', pick: (tracks) => tracks.filter((t) => !t.plays) },
  // Un favori jamais écouté compte depuis son ajout : un coup de cœur tout neuf n'est pas « oublié ».
  { id: 'forgotten', name: 'Coups de cœur oubliés', pick: (tracks, now) => tracks.filter((t) => t.fav && now - (t.lastPlayed || t.addedAt || now) > 30 * DAY) },
];

export function smartTracks(id, tracks, now = Date.now()) {
  return SMART.find((s) => s.id === id)?.pick(tracks, now) || [];
}

export function recentlyPlayed(tracks, limit = 12) {
  return tracks.filter((t) => t.lastPlayed).sort((a, b) => b.lastPlayed - a.lastPlayed).slice(0, limit);
}
