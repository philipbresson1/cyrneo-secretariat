/**
 * Ce que le secrétariat fait d'un mail trié. Pur : aucune action n'est exécutée ici.
 */
import type { Action, Classification, Config, Intervention, MailRecu } from './types';
import { coordonneesManquantes } from './modeles';

export type Contexte = {
  config: Config;
  /** null si on peut répondre automatiquement, sinon la raison du refus. */
  raisonPasDeReponse: string | null;
  /** Une réponse automatique est déjà partie vers cette adresse récemment. */
  dejaRepondu: boolean;
  /** Intervention en attente de coordonnées à laquelle ce mail répond. */
  interventionLiee: Intervention | null;
};

export function societeRetenue(c: Classification, mail: MailRecu, config: Config): string {
  if (c.societe !== 'inconnue') return c.societe;
  return config.boites.find((b) => b.id === mail.boite)?.societeParDefaut ?? config.societes[0].id;
}

/** Fusionne les coordonnées déjà connues avec celles du nouveau mail (le nouveau l'emporte). */
export function fusionnerContact(c: Classification, i: Intervention): Classification {
  return {
    ...c,
    nature: c.nature || i.nature,
    contact: {
      nom: c.contact.nom || i.client_nom,
      telephone: c.contact.telephone || i.client_telephone,
      email: c.contact.email || i.client_email,
      adresse: c.contact.adresse || i.adresse,
      commune: c.contact.commune || i.commune,
    },
  };
}

const LIBELLE_MANQUANT: Record<string, string> = { telephone: 'téléphone', adresse: 'adresse' };

export function decider(mail: MailRecu, c: Classification, ctx: Contexte): Action[] {
  const societe = societeRetenue(c, mail, ctx.config);
  const peutRepondre = ctx.raisonPasDeReponse === null && !ctx.dejaRepondu;
  const actions: Action[] = [];

  if (ctx.interventionLiee) {
    const i = ctx.interventionLiee;
    const complet = fusionnerContact(c, i);
    const manquants = coordonneesManquantes(complet, i.type);
    if (manquants.length === 0) {
      actions.push({ type: 'completer_intervention', interventionId: i.id, statut: 'a_planifier' });
      if (i.type === 'intervention' && !i.dolibarr_ref && avecDolibarr(i.societe, ctx.config)) actions.push({ type: 'bon_dolibarr' });
      actions.push({ type: 'rainbow', societe: i.societe, gabarit: 'complement', suite: 'À rappeler pour planifier.' });
      if (ctx.raisonPasDeReponse === null) {
        actions.push({ type: 'repondre', modele: i.type === 'devis' ? 'accuse_devis' : 'accuse_intervention', manquants: [] });
      }
    } else {
      // Deuxième réponse toujours incomplète : on ne relance pas le client une seconde
      // fois par mail (risque de ping-pong), on passe la main à un humain.
      actions.push({ type: 'completer_intervention', interventionId: i.id, statut: 'coordonnees_demandees' });
      actions.push({
        type: 'rainbow',
        societe: i.societe,
        gabarit: 'complement',
        suite: `Réponse du client encore incomplète (manque : ${manquants.map((m) => LIBELLE_MANQUANT[m] ?? m).join(', ')}). À recontacter par mail.`,
      });
    }
    return [...actions, ...transferts(c, societe, ctx.config)];
  }

  switch (c.categorie) {
    case 'demande_intervention':
    case 'demande_devis':
    case 'complement_coordonnees': {
      // Un « complément » qu'on ne relie à aucune demande est traité comme une demande.
      const type = c.categorie === 'demande_devis' ? 'devis' : 'intervention';
      const manquants = coordonneesManquantes(c, type);
      actions.push({ type: 'creer_intervention', nature: type, statut: manquants.length > 0 ? 'coordonnees_demandees' : 'a_planifier' });
      // Le bon Dolibarr attend d'avoir de quoi joindre le client : sinon il serait créé vide.
      if (type === 'intervention' && manquants.length === 0 && avecDolibarr(societe, ctx.config)) actions.push({ type: 'bon_dolibarr' });

      let suite: string;
      if (!peutRepondre) {
        const raison = ctx.dejaRepondu ? 'client déjà prévenu récemment' : ctx.raisonPasDeReponse;
        suite = `Aucune réponse automatique (${raison}). À rappeler.`;
      } else if (manquants.length > 0) {
        actions.push({ type: 'repondre', modele: 'demande_coordonnees', manquants });
        suite = `Coordonnées demandées au client par mail (manque : ${manquants.map((m) => LIBELLE_MANQUANT[m] ?? m).join(', ')}).`;
      } else {
        actions.push({ type: 'repondre', modele: type === 'devis' ? 'accuse_devis' : 'accuse_intervention', manquants: [] });
        suite = type === 'devis' ? 'Accusé envoyé au client. Devis à chiffrer.' : 'Accusé envoyé au client. À rappeler pour planifier.';
      }
      actions.push({ type: 'rainbow', societe, gabarit: 'nouvelle', suite });
      break;
    }
    case 'reclamation':
      // Sur l'écran du bureau avec les interventions à prévoir ; jamais de réponse automatique.
      actions.push({ type: 'creer_intervention', nature: 'reclamation', statut: 'a_planifier' });
      actions.push({ type: 'rainbow', societe, gabarit: 'reclamation', suite: 'À traiter.' });
      break;
    case 'relance_client':
      actions.push({ type: 'rainbow', societe, gabarit: 'relance', suite: 'Client à rappeler.' });
      break;
    case 'facture_recue':
      if (mail.piecesJointes.length > 0) actions.push({ type: 'classer_pieces_jointes' });
      break;
    default:
      break;
  }

  return [...actions, ...transferts(c, societe, ctx.config)];
}

function avecDolibarr(societe: string, config: Config): boolean {
  return config.dolibarr.actif && societe in config.dolibarr.entites;
}

function transferts(c: Classification, societe: string, config: Config): Action[] {
  const vers = new Set<string>();
  for (const regle of config.transferts) {
    if (!regle.categories.includes(c.categorie)) continue;
    if (regle.societes !== '*' && !regle.societes.includes(societe)) continue;
    regle.vers.forEach((v) => vers.add(v.toLowerCase()));
  }
  return vers.size > 0 ? [{ type: 'transferer', vers: [...vers] }] : [];
}
