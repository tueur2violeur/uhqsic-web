// File de lecture, sans rien d'audio : `items` garde l'ordre d'origine,
// `order` l'ordre de lecture (mélangé ou non), `cursor` la position dans `order`.
// Même logique que PlaybackQueue.swift de l'app iPhone.

export const RepeatMode = Object.freeze({ off: 0, all: 1, one: 2 });

export function nextRepeatMode(mode) {
  return (mode + 1) % 3;
}

export class PlaybackQueue {
  constructor(random = Math.random) {
    this.random = random;
    this.items = [];
    this.order = [];
    this.cursor = 0;
    this.isShuffled = false;
    this.repeatMode = RepeatMode.off;
  }

  get current() {
    return this.cursor >= 0 && this.cursor < this.order.length ? this.items[this.order[this.cursor]] : null;
  }

  get isEmpty() {
    return this.order.length === 0;
  }

  /** Le morceau où mènerait « suivant ». */
  get upNext() {
    if (this.isEmpty) return null;
    if (this.cursor + 1 < this.order.length) return this.items[this.order[this.cursor + 1]];
    return this.repeatMode === RepeatMode.off ? null : this.items[this.order[0]];
  }

  load(items, startAt, shuffled) {
    this.items = items.slice();
    this.order = items.map((_, i) => i);
    this.cursor = startAt >= 0 && startAt < items.length ? startAt : 0;
    this.isShuffled = false;
    if (shuffled) this.setShuffled(true);
  }

  /** Le morceau en cours reste en cours : en tête en mélangeant, retrouvé en revenant à l'ordre normal. */
  setShuffled(on) {
    this.isShuffled = on;
    if (this.isEmpty) return;
    const currentIndex = this.order[this.cursor];
    if (on) {
      const rest = this.items.map((_, i) => i).filter((i) => i !== currentIndex);
      for (let i = rest.length - 1; i > 0; i--) {
        const j = Math.floor(this.random() * (i + 1));
        [rest[i], rest[j]] = [rest[j], rest[i]];
      }
      this.order = [currentIndex, ...rest];
      this.cursor = 0;
    } else {
      this.order = this.items.map((_, i) => i);
      this.cursor = currentIndex;
    }
  }

  /** Fin naturelle d'un morceau. `false` = s'arrêter (la file revient au début). */
  advanceAfterFinish() {
    if (this.isEmpty) return false;
    if (this.repeatMode === RepeatMode.one) return true;
    if (this.cursor + 1 < this.order.length) {
      this.cursor += 1;
      return true;
    }
    this.cursor = 0;
    return this.repeatMode === RepeatMode.all;
  }

  /** Bouton « suivant » : ignore la boucle sur le morceau. `false` = fin de file, en pause. */
  skipForward() {
    if (this.isEmpty) return false;
    if (this.cursor + 1 < this.order.length) {
      this.cursor += 1;
      return true;
    }
    this.cursor = 0;
    return this.repeatMode !== RepeatMode.off;
  }

  skipBackward() {
    if (this.isEmpty) return;
    if (this.cursor > 0) this.cursor -= 1;
    else if (this.repeatMode !== RepeatMode.off) this.cursor = this.order.length - 1;
  }

  /** Les prochains éléments dans l'ordre de lecture (pour la file d'attente affichée). */
  upcoming(limit = 50) {
    return this.order.slice(this.cursor + 1, this.cursor + 1 + limit).map((i, k) => ({ item: this.items[i], position: this.cursor + 1 + k }));
  }

  /** « Lire ensuite » : place un élément juste après celui en cours. */
  insertNext(item) {
    this.items.push(item);
    const index = this.items.length - 1;
    if (this.order.length === 0) {
      this.order = [index];
      this.cursor = 0;
    } else {
      this.order.splice(this.cursor + 1, 0, index);
    }
  }

  /** « Lire en dernier » : à la fin de la file. */
  insertLast(item) {
    this.items.push(item);
    this.order.push(this.items.length - 1);
    if (this.order.length === 1) this.cursor = 0;
  }

  /** Déplace un morceau à venir dans la file (positions de l'ordre de lecture, après le morceau en cours). */
  move(from, to) {
    const min = this.cursor + 1;
    if (from < min || to < min || from >= this.order.length || to >= this.order.length || from === to) return;
    const [index] = this.order.splice(from, 1);
    this.order.splice(to, 0, index);
  }

  /** Retire un morceau à venir de la file, sans toucher à la bibliothèque. */
  removeAt(position) {
    if (position <= this.cursor || position >= this.order.length) return;
    this.order.splice(position, 1);
  }

  /** Saute à une position de l'ordre de lecture. */
  jumpTo(position) {
    if (position >= 0 && position < this.order.length) this.cursor = position;
  }

  /** Retire des éléments ; renvoie `true` si l'élément en cours en faisait partie. */
  removeWhere(shouldRemove) {
    if (this.isEmpty) return false;
    const currentIndex = this.order[this.cursor];
    const removed = new Set(this.items.map((item, i) => (shouldRemove(item) ? i : -1)).filter((i) => i >= 0));
    if (removed.size === 0) return false;

    const remap = new Map();
    const kept = [];
    this.items.forEach((item, i) => {
      if (!removed.has(i)) {
        remap.set(i, kept.length);
        kept.push(item);
      }
    });
    const removedBeforeCursor = this.order.slice(0, this.cursor).filter((i) => removed.has(i)).length;
    const currentRemoved = removed.has(currentIndex);

    this.items = kept;
    this.order = this.order.filter((i) => remap.has(i)).map((i) => remap.get(i));
    this.cursor = Math.max(0, this.cursor - removedBeforeCursor);
    if (this.cursor >= this.order.length) this.cursor = Math.max(0, this.order.length - 1);
    return currentRemoved;
  }

  clear() {
    this.items = [];
    this.order = [];
    this.cursor = 0;
  }
}
