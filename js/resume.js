// Reprise après une interruption d'iOS (Siri, appel, alarme, message vocal…).
// Safari ne relance jamais tout seul une app web après une interruption. Avec l'API Audio Session
// (iOS 16.4 et plus), on sait quand l'interruption commence et finit : on relance alors la musique,
// mais seulement si elle jouait juste avant et que personne ne l'a mise en pause exprès.
// iOS n'envoie pas toujours ses signaux dans le même ordre (pause puis interruption, ou l'inverse) :
// on se fie donc au dernier instant où la musique jouait vraiment.

const RECENT = 3000; // la musique jouait il y a moins de 3 s : l'interruption l'a coupée
const MAX_WAIT = 30 * 60000; // au-delà, on ne relance plus (on a sûrement oublié la musique)

export function createResumer({ isPaused, play, now = () => Date.now() }) {
  let lastPlayingAt = -Infinity;
  let pendingSince = 0;

  const api = {
    /** Pendant la lecture (à chaque mise à jour du temps). */
    heard() {
      if (!isPaused()) lastPlayingAt = now();
    },
    /** Juste avant une pause voulue : bouton, écran verrouillé, AirPods, minuterie, fin de file. */
    pausing() {
      lastPlayingAt = -Infinity;
      pendingSince = 0;
    },
    /** La musique joue : plus rien à reprendre. */
    played() {
      lastPlayingAt = now();
      pendingSince = 0;
    },
    /** Nouvel état de navigator.audioSession. Renvoie true si une reprise est lancée. */
    session(state) {
      if (state === 'interrupted') {
        if (!isPaused() || now() - lastPlayingAt < RECENT) pendingSince = now();
        return false;
      }
      return api.resume();
    },
    /** Retour dans l'app, ou fin d'interruption : relance si une reprise est en attente. */
    resume() {
      if (!pendingSince) return false;
      if (now() - pendingSince > MAX_WAIT || !isPaused()) {
        pendingSince = 0;
        return false;
      }
      // Refusée (iOS l'interdit parfois en arrière-plan) : la reprise reste en attente
      // et se fera au retour dans l'app, sans avoir à toucher Lecture.
      Promise.resolve(play()).then(() => { pendingSince = 0; }, () => {});
      return true;
    },
    get waiting() {
      return pendingSince > 0;
    },
  };
  return api;
}
