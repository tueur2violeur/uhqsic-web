// Sauvegarde et restauration : infos, favoris, paroles, écoutes, playlists et statistiques.
// Les fichiers audio n'y sont pas (trop lourds) : sur un nouveau téléphone, on réimporte
// les mêmes fichiers puis on restaure, et chaque morceau est retrouvé par son nom de fichier.

const KEPT = ['title', 'artist', 'album', 'fav', 'plays', 'playsBy', 'lastPlayed', 'lyrics', 'syncedLyrics', 'lyricsInstrumental', 'lyricsSource', 'lyricsOffset', 'lyricsLength', 'rating', 'moods', 'addedAt'];

export function buildBackup(tracks, playlists, stats, prefs, now = new Date()) {
  return {
    app: 'Uhqsic',
    version: 1,
    savedAt: now.toISOString(),
    tracks: tracks.map((t) => ({
      key: t.id,
      fileName: t.fileName,
      duration: Math.round(t.duration || 0),
      ...Object.fromEntries(KEPT.filter((k) => t[k] !== undefined && t[k] !== null && t[k] !== '').map((k) => [k, t[k]])),
    })),
    playlists: playlists.map((p) => ({ name: p.name, createdAt: p.createdAt, trackKeys: p.trackIds })),
    stats,
    prefs,
  };
}

/** Retrouve chaque morceau sauvegardé dans la bibliothèque actuelle : même nom de fichier, durée proche. */
export function matchBackup(backup, tracks) {
  if (backup?.app !== 'Uhqsic' || !Array.isArray(backup.tracks)) throw new Error('Ce fichier n\'est pas une sauvegarde Uhqsic.');
  const byName = new Map();
  for (const t of tracks) {
    const list = byName.get(t.fileName) || [];
    list.push(t);
    byName.set(t.fileName, list);
  }
  const used = new Set();
  const map = new Map(); // clé sauvegardée → id actuel
  for (const saved of backup.tracks) {
    const candidates = (byName.get(saved.fileName) || []).filter((t) => !used.has(t.id));
    const match = candidates.find((t) => Math.abs((t.duration || 0) - saved.duration) <= 2) || candidates[0];
    if (match) {
      map.set(saved.key, match.id);
      used.add(match.id);
    }
  }
  return {
    map,
    found: map.size,
    missing: backup.tracks.length - map.size,
    updates: backup.tracks.filter((s) => map.has(s.key)).map((s) => ({
      id: map.get(s.key),
      fields: Object.fromEntries(KEPT.filter((k) => k in s).map((k) => [k, s[k]])),
    })),
    playlists: (backup.playlists || []).map((p) => ({
      name: p.name,
      createdAt: p.createdAt || Date.now(),
      trackIds: (p.trackKeys || []).map((k) => map.get(k)).filter(Boolean),
    })),
  };
}
