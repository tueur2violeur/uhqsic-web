// Stockage local (IndexedDB) : tout reste dans le téléphone.
// tracks : métadonnées + pochettes ; files : le fichier audio ; playlists : nom + ids ordonnés.

const DB_NAME = 'uhqsic';
const VERSION = 1;
let dbPromise;

function open() {
  dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('tracks')) db.createObjectStore('tracks', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files');
      if (!db.objectStoreNames.contains('playlists')) db.createObjectStore('playlists', { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

function done(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function run(stores, mode, work) {
  const db = await open();
  const tx = db.transaction(stores, mode);
  const completed = new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transaction annulée'));
  });
  const result = await work(tx);
  await completed;
  return result;
}

export const db = {
  allTracks: () => run(['tracks'], 'readonly', (tx) => done(tx.objectStore('tracks').getAll())),
  allPlaylists: () => run(['playlists'], 'readonly', (tx) => done(tx.objectStore('playlists').getAll())),
  file: (id) => run(['files'], 'readonly', (tx) => done(tx.objectStore('files').get(id))),
  saveTrack: (track) => run(['tracks'], 'readwrite', (tx) => tx.objectStore('tracks').put(track)),

  addTrack: (track, blob) =>
    run(['tracks', 'files'], 'readwrite', (tx) => {
      tx.objectStore('tracks').put(track);
      tx.objectStore('files').put(blob, track.id);
    }),

  deleteTrack: (id, playlists) =>
    run(['tracks', 'files', 'playlists'], 'readwrite', (tx) => {
      tx.objectStore('tracks').delete(id);
      tx.objectStore('files').delete(id);
      for (const p of playlists) tx.objectStore('playlists').put(p);
    }),

  /** Même morceau sur deux appareils : il prend l'identifiant commun (fichier et playlists suivent). */
  rekeyTrack: (oldId, track, blob, playlists) =>
    run(['tracks', 'files', 'playlists'], 'readwrite', (tx) => {
      tx.objectStore('tracks').delete(oldId);
      tx.objectStore('files').delete(oldId);
      tx.objectStore('tracks').put(track);
      if (blob) tx.objectStore('files').put(blob, track.id);
      for (const p of playlists) tx.objectStore('playlists').put(p);
    }),

  savePlaylist: (playlist) => run(['playlists'], 'readwrite', (tx) => tx.objectStore('playlists').put(playlist)),
  deletePlaylist: (id) => run(['playlists'], 'readwrite', (tx) => tx.objectStore('playlists').delete(id)),
};

/** Efface toute la bibliothèque (morceaux, fichiers, playlists). */
export async function wipeDatabase() {
  if (dbPromise) (await dbPromise).close();
  dbPromise = null;
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = resolve;
    request.onerror = () => reject(request.error);
    request.onblocked = resolve;
  });
}

/** Demande à Safari de ne jamais effacer les données (accordé aux apps de l'écran d'accueil). */
export async function persistStorage() {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist();
  } catch {
    // Non supporté : sans conséquence pour une app de l'écran d'accueil.
  }
}
