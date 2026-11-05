// Import d'un fichier choisi dans Fichiers : tags, durée, pochette réduite, couleur.
// Aucun décodage audio : l'import d'un morceau prend une fraction de seconde.
import { readTags } from './tags.js';
import { parseFileName } from './names.js';

export async function importFile(file) {
  const tags = await readTags(file);
  const fallback = parseFileName(file.name);
  // Durée inconnue (format inhabituel) : complétée à la première lecture.
  const duration = Number.isFinite(tags.duration) ? tags.duration : 0;

  const { art, thumb, tint } = tags.picture
    ? await processArtwork(new Blob([tags.picture.data], { type: tags.picture.mime }))
    : { art: null, thumb: null, tint: null };

  return {
    track: {
      id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      title: tags.title || fallback.title,
      artist: tags.artist || fallback.artist || 'Artiste inconnu',
      album: tags.album || '',
      duration,
      fileName: file.name,
      addedAt: Date.now(),
      art,
      thumb,
      tint,
    },
    blob: file,
  };
}

/** Pochette (du fichier ou trouvée en ligne) → grande, vignette et couleur moyenne. */
export async function processArtwork(blob) {
  try {
    // Décodée directement en petit : une pochette de 3000 px ne passe jamais en mémoire en entier.
    const bitmap = await createImageBitmap(blob, { resizeWidth: 640, resizeQuality: 'high' }).catch(() => createImageBitmap(blob));
    const result = { art: await resize(bitmap, 640, 0.85), thumb: await resize(bitmap, 144, 0.8), tint: averageColor(bitmap) };
    bitmap.close?.();
    return result;
  } catch {
    // Image illisible : le morceau garde son apparence actuelle.
    return { art: null, thumb: null, tint: null };
  }
}

function resize(bitmap, max, quality) {
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
}

function averageColor(bitmap) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const context = canvas.getContext('2d');
  context.drawImage(bitmap, 0, 0, 1, 1);
  const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
  return [r, g, b];
}
