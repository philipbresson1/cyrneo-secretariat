/**
 * Rendez-vous du jour, lus en temps réel depuis l'agenda Google.
 *
 * Source : l'adresse secrète au format iCal de l'agenda personnel
 * (variable AGENDA_ICS_URL). Ce choix évite toute configuration Google Cloud :
 * la publication d'une application OAuth avec des accès « sensibles » exige des
 * pages légales publiques, hors de proportion pour un tableau de bord privé.
 */
import ical from 'node-ical';

export type Rdv = {
  titre: string;
  debut: Date | null; // null si journée entière
  fin: Date | null;
  journeeEntiere: boolean;
  lieu: string | null;
  passe: boolean;
  description: string; // notes du rendez-vous (contact, consignes), vide si aucune
  uid: string; // identifiant iCal, stable d'une lecture à l'autre
};

export type ResultatAgenda =
  | { etat: 'non-configure' }
  | { etat: 'erreur'; message: string }
  | { etat: 'ok'; rdvs: Rdv[] };

/** Titre comparable d'un jour à l'autre (casse, accents, ponctuation) : un chantier repris
 *  chaque jour sous le même intitulé est reconnu comme un seul chantier. */
export const titreComparable = (t: string): string =>
  t
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((m) => m.length > 1) // « d’escalier » = « escalier »
    .join(' ');

/** Samedi ou dimanche, à Paris : un chantier arrêté le week-end reste le même chantier. */
export function estWeekEnd(date: Date): boolean {
  return /^(Sat|Sun)/.test(new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Paris', weekday: 'short' }).format(date));
}

/** Jour calendaire ('YYYY-MM-DD') à Paris, correct de part et d'autre du changement d'heure. */
export function jourParis(date: Date): string {
  return new Intl.DateTimeFormat('fr-CA', {
    timeZone: 'Europe/Paris',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/** Décalage horaire de Paris ce jour-là, au format '+02:00'. */
export function decalageParis(date: Date): string {
  const nom = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Paris',
    timeZoneName: 'longOffset',
  })
    .formatToParts(date)
    .find((p) => p.type === 'timeZoneName')?.value;
  const decalage = (nom ?? 'GMT+00:00').replace('GMT', '');
  return decalage === '' ? '+00:00' : decalage;
}

/** Bornes du jour de `maintenant`, en heure de Paris. */
function bornesDuJour(maintenant: Date): { debut: Date; fin: Date; jour: string } {
  const jour = jourParis(maintenant);
  // Décalage figé au milieu du jour visé, jamais sur `maintenant` : aux deux dates de
  // bascule heure d'été/hiver, l'offset diffère selon l'heure de la journée, donc le
  // prendre au moment de l'appel décale minuit et/ou 23h59 d'une heure ce jour-là.
  const milieuDuJour = new Date(`${jour}T12:00:00Z`);
  const decalage = decalageParis(milieuDuJour);
  return {
    jour,
    debut: new Date(`${jour}T00:00:00${decalage}`),
    fin: new Date(`${jour}T23:59:59.999${decalage}`),
  };
}

type EvenementIcs = {
  type?: string;
  summary?: string;
  status?: string;
  location?: string;
  description?: string | { val?: string };
  uid?: string;
  start?: Date & { dateOnly?: boolean };
  end?: Date & { dateOnly?: boolean };
  rrule?: { between: (apres: Date, avant: Date, inclusif?: boolean) => Date[] };
  exdate?: Record<string, Date>;
  recurrences?: Record<string, EvenementIcs>;
};

/** 'YYYY-MM-DD' d'une date « journée entière » de node-ical (minuit, heure locale du processus). */
function jourLocal(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function estJourneeEntiere(evenement: EvenementIcs): boolean {
  // node-ical marque les dates sans heure par la propriété booléenne dateOnly sur le Date lui-même.
  return evenement.start?.dateOnly === true;
}

function construire(
  evenement: EvenementIcs,
  debut: Date | null,
  fin: Date | null,
  maintenant: Date
): Rdv {
  const journeeEntiere = estJourneeEntiere(evenement);
  return {
    titre: evenement.summary?.trim() || '(sans titre)',
    debut: journeeEntiere ? null : debut,
    fin: journeeEntiere ? null : fin,
    journeeEntiere,
    lieu: evenement.location?.trim() || null,
    // Une journée entière n'est jamais considérée comme passée.
    passe: !journeeEntiere && fin !== null && fin.getTime() < maintenant.getTime(),
    description: (typeof evenement.description === 'string' ? evenement.description : evenement.description?.val ?? '').trim(),
    // Une occurrence de rendez-vous répété a le même UID : la date la distingue.
    uid: `${evenement.uid ?? evenement.summary ?? ''}@${debut?.toISOString() ?? 'jour'}`,
  };
}

/** Extrait les rendez-vous du jour, récurrences développées, annulés exclus, triés. */
export function rdvDuJour(texteIcs: string, maintenant: Date): Rdv[] {
  return rdvDuJourAnalyse(ical.sync.parseICS(texteIcs) as unknown as Record<string, EvenementIcs>, maintenant);
}

/** Rendez-vous de plusieurs jours de suite (l'agenda n'est analysé qu'une fois). */
export function rdvDesJours(texteIcs: string, premier: Date, jours: number): { date: Date; rdvs: Rdv[] }[] {
  const analyse = ical.sync.parseICS(texteIcs) as unknown as Record<string, EvenementIcs>;
  return Array.from({ length: jours }, (_, n) => {
    const date = new Date(premier.getTime() + n * 86_400_000);
    return { date, rdvs: rdvDuJourAnalyse(analyse, date) };
  });
}

function rdvDuJourAnalyse(analyse: Record<string, EvenementIcs>, maintenant: Date): Rdv[] {
  const { debut: debutJour, fin: finJour, jour } = bornesDuJour(maintenant);
  const rdvs: Rdv[] = [];

  for (const evenement of Object.values(analyse)) {
    if (evenement.type !== 'VEVENT' || evenement.status === 'CANCELLED') continue;
    if (!evenement.start) continue;

    const duree = evenement.end ? evenement.end.getTime() - evenement.start.getTime() : 0;

    if (evenement.rrule) {
      // Fenêtre élargie d'un jour de part et d'autre : une occurrence peut
      // commencer la veille et déborder sur le jour visé.
      const marge = 24 * 60 * 60 * 1000;
      // EXDATE vise un instant précis, pas toute la journée : une exclusion à 9h
      // ne doit pas effacer une autre occurrence du même jour à 17h.
      const exclusions = new Set(Object.values(evenement.exdate ?? {}).map((d) => d.getTime()));

      // node-ical range une même occurrence redéfinie sous deux clés RECURRENCE-ID
      // (date seule et horodatage complet) : l'ensemble ci-dessous ne sert qu'à
      // retirer l'occurrence ORIGINALE de la génération par règle, quel que soit le
      // nombre de clés qui pointent vers son remplacement.
      const clesRedefinies = new Set(
        Object.keys(evenement.recurrences ?? {}).map((cle) => new Date(cle).getTime())
      );

      const occurrences = evenement.rrule.between(
        new Date(debutJour.getTime() - marge),
        new Date(finJour.getTime() + marge),
        true
      );

      for (const occurrence of occurrences) {
        if (exclusions.has(occurrence.getTime())) continue;
        if (clesRedefinies.has(occurrence.getTime())) continue;
        const finOccurrence = new Date(occurrence.getTime() + duree);
        // L'occurrence compte si elle chevauche le jour visé.
        if (finOccurrence < debutJour || occurrence > finJour) continue;
        rdvs.push(construire(evenement, occurrence, finOccurrence, maintenant));
      }

      // Occurrences redéfinies (déplacées ou annulées) : filtrées et positionnées sur
      // leur date RÉELLE (remplacement.start), jamais sur le RECURRENCE-ID d'origine —
      // sinon un rendez-vous déplacé à aujourd'hui reste invisible, et un rendez-vous
      // d'aujourd'hui déplacé ailleurs continue d'apparaître. Dédupliquées par date de
      // début réelle : les deux clés d'une même occurrence ne doivent produire qu'une ligne.
      const remplacementsVus = new Set<number>();
      for (const remplacement of Object.values(evenement.recurrences ?? {})) {
        if (remplacement.status === 'CANCELLED' || !remplacement.start) continue;
        const debutReel = remplacement.start.getTime();
        if (remplacementsVus.has(debutReel)) continue;
        remplacementsVus.add(debutReel);

        const finRemplacement = remplacement.end ?? new Date(remplacement.start.getTime() + duree);
        if (finRemplacement < debutJour || remplacement.start > finJour) continue;
        rdvs.push(construire(remplacement, remplacement.start, finRemplacement, maintenant));
      }
      continue;
    }

    if (estJourneeEntiere(evenement)) {
      // Le DTEND d'une journée entière est exclusif : un événement d'un jour
      // va du 24 au 25, il faut donc comparer sur l'intervalle et non l'égalité.
      // node-ical crée ces dates à minuit dans le fuseau du processus (Paris sur le PC, UTC sur
      // Vercel) : on compare donc des jours calendaires, jamais des instants.
      const premierJour = jourLocal(evenement.start);
      const finExclusive = evenement.end ? jourLocal(evenement.end) : jourLocal(new Date(evenement.start.getTime() + 86_400_000));
      if (premierJour <= jour && finExclusive > jour) {
        rdvs.push(construire(evenement, null, null, maintenant));
      }
      continue;
    }

    const fin = evenement.end ?? new Date(evenement.start.getTime() + duree);
    if (fin >= debutJour && evenement.start <= finJour) {
      rdvs.push(construire(evenement, evenement.start, fin, maintenant));
    }
  }

  return rdvs.sort((a, b) => {
    if (a.journeeEntiere !== b.journeeEntiere) return a.journeeEntiere ? -1 : 1;
    return (a.debut?.getTime() ?? 0) - (b.debut?.getTime() ?? 0);
  });
}

/**
 * Récupère les rendez-vous du jour. Ne lève jamais : toute panne est rendue
 * sous forme d'état `erreur` pour que le dashboard reste affichable.
 */
export async function chargerRdvDuJour(maintenant: Date = new Date()): Promise<ResultatAgenda> {
  const url = process.env.AGENDA_ICS_URL;
  if (!url) return { etat: 'non-configure' };

  try {
    // Rafraîchi au plus une fois par minute : assez frais pour un rendez-vous,
    // sans rappeler Google à chaque rechargement de page.
    const reponse = await fetch(url, { next: { revalidate: 60 } });
    if (!reponse.ok) {
      return { etat: 'erreur', message: `Agenda injoignable (HTTP ${reponse.status})` };
    }
    return { etat: 'ok', rdvs: rdvDuJour(await reponse.text(), maintenant) };
  } catch (e) {
    // Ne JAMAIS renvoyer e.message au client : une URL mal saisie (ex. protocole
    // https:// oublié) fait échouer le parsing d'URL avec un message d'erreur qui
    // contient l'adresse complète, secret d'accès permanent à l'agenda inclus. Le
    // détail reste uniquement dans les logs serveur.
    console.error('Chargement agenda échoué :', e);
    const urlInvalide = e instanceof TypeError && /url/i.test(e.message);
    return { etat: 'erreur', message: urlInvalide ? "Adresse d'agenda invalide" : 'Agenda injoignable' };
  }
}
