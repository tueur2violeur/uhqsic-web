// Repli quand un fichier n'a pas de tags : « 03 - Artiste - Titre.flac » → (Artiste, Titre).
// Même règles que FilenameParser.swift.

export function parseFileName(fileName) {
  let name = fileName.replace(/\.[^.]+$/, '').replace(/_/g, ' ').trim();
  name = dropTrackNumber(name);
  const parts = name.split(' - ').map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 2) return { artist: parts[0], title: parts.slice(1).join(' - ') };
  return { artist: null, title: name || fileName };
}

// « 03 - Titre », « 3. Titre », « 03) Titre », « 01 Titre » → « Titre ».
// Gardés : « 1999 » (titre numérique), « 2 Unlimited » (un chiffre + espace ressemble à un nom).
function dropTrackNumber(name) {
  const match = /^(\d{1,3})([ .\-)]+)(.+)$/.exec(name);
  if (!match) return name;
  const [, digits, separators, rest] = match;
  const onlySpaces = /^ +$/.test(separators);
  if (onlySpaces && digits[0] !== '0') return name;
  return rest;
}
