/**
 * Accès Supabase du secrétariat (clé service-role, PC uniquement).
 */
import { creerClientAdmin } from '../lib/supabase/admin';
import type { ActionExecutee, Classification, Intervention, MailRecu, StatutIntervention, TypeDemande } from '../logique/types';
import { referenceIntervention } from '../logique/modeles';
import { estInterne } from '../logique/garde-fous';

// Créé au premier appel : .env.local doit être chargé avant.
let client: ReturnType<typeof creerClientAdmin> | null = null;
const sb = new Proxy({} as ReturnType<typeof creerClientAdmin>, {
  get: (_cible, prop) => {
    client ??= creerClientAdmin();
    return Reflect.get(client, prop, client);
  },
});

function verifier<T>(r: { data: T; error: { message: string } | null }, quoi: string): T {
  if (r.error) throw new Error(`${quoi} : ${r.error.message}`);
  return r.data;
}

/** Sujet comparable (casse et espaces). Les préfixes « Re: » sont gardés exprès : une réponse
 *  du client (coordonnées, relance) n'est jamais un doublon. */
export function sujetNormalise(sujet: string): string {
  return sujet.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Même mail déjà reçu (même expéditeur, même sujet, 7 derniers jours) ayant donné une demande :
 *  un bon envoyé deux fois, ou en copie sur deux boîtes, ne doit créer qu'une fiche. */
export async function demandeEnDouble(mail: MailRecu): Promise<{ interventionId: number; reference: string } | null> {
  const depuis = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const data = verifier(
    await sb
      .from('secretariat_journal')
      .select('sujet, intervention_id')
      .eq('expediteur_adresse', mail.deAdresse.toLowerCase())
      .not('intervention_id', 'is', null)
      .gte('recu_le', depuis),
    'Recherche doublon'
  ) as { sujet: string; intervention_id: number }[];
  const cible = sujetNormalise(mail.sujet);
  const trouve = (data ?? []).find((l) => sujetNormalise(l.sujet) === cible);
  if (!trouve) return null;
  const inter = await interventionParId(trouve.intervention_id);
  return inter ? { interventionId: inter.id, reference: inter.reference } : null;
}

/** Vérifie que la base répond et que la clé donne accès aux tables. */
export async function testerBase(): Promise<number> {
  const r = await sb.from('secretariat_journal').select('id', { count: 'exact', head: true });
  if (r.error) {
    if (r.status === 401 || /api key|jwt/i.test(r.error.message)) throw new Error('clé SUPABASE_SERVICE_ROLE refusée (clé incomplète ou d’un autre projet ?)');
    throw new Error(r.error.message || `base injoignable (HTTP ${r.status})`);
  }
  return r.count ?? 0;
}

export async function lireCurseur(boite: string): Promise<{ uidValidity: string; dernierUid: number } | null> {
  const data = verifier(await sb.from('secretariat_curseurs').select('uid_validity, dernier_uid').eq('boite', boite).maybeSingle(), 'Lecture curseur');
  return data ? { uidValidity: data.uid_validity, dernierUid: Number(data.dernier_uid) } : null;
}

export async function ecrireCurseur(boite: string, uidValidity: string, dernierUid: number): Promise<void> {
  verifier(
    await sb.from('secretariat_curseurs').upsert({ boite, uid_validity: uidValidity, dernier_uid: dernierUid, maj_le: new Date().toISOString() }),
    'Écriture curseur'
  );
}

export async function dejaJournalise(boite: string, messageId: string): Promise<boolean> {
  const data = verifier(await sb.from('secretariat_journal').select('id').eq('boite', boite).eq('message_id', messageId).maybeSingle(), 'Lecture journal');
  return data !== null;
}

export type LigneJournal = {
  mail: MailRecu;
  classification: Classification | null;
  societe: string | null;
  actions: ActionExecutee[];
  statut: 'traite' | 'rien_a_faire' | 'simulation' | 'erreur';
  erreur?: string;
  interventionId?: number | null;
  fichiers?: string[];
};

export async function journaliser(l: LigneJournal): Promise<number> {
  const data = verifier(
    await sb
      .from('secretariat_journal')
      .upsert(
        {
          boite: l.mail.boite,
          message_id: l.mail.messageId,
          recu_le: l.mail.recuLe.toISOString(),
          expediteur: l.mail.deNom ? `${l.mail.deNom} <${l.mail.deAdresse}>` : l.mail.deAdresse,
          expediteur_adresse: l.mail.deAdresse.toLowerCase(),
          sujet: l.mail.sujet,
          categorie: l.classification?.categorie ?? null,
          societe: l.societe,
          urgence: l.classification?.urgence ?? null,
          resume: l.classification?.resume ?? null,
          actions: l.actions,
          statut: l.statut,
          erreur: l.erreur ?? null,
          intervention_id: l.interventionId ?? null,
          fichiers: l.fichiers ?? [],
          traite_le: new Date().toISOString(),
        },
        { onConflict: 'boite,message_id' }
      )
      .select('id')
      .single(),
    'Écriture journal'
  );
  return Number((data as { id: number }).id);
}

export async function creerIntervention(
  mail: MailRecu,
  c: Classification,
  societe: string,
  type: TypeDemande,
  statut: StatutIntervention
): Promise<Intervention> {
  const cree = verifier(
    await sb
      .from('interventions')
      .insert({
        type,
        societe,
        statut,
        urgence: c.urgence,
        client_nom: c.contact.nom,
        client_telephone: c.contact.telephone,
        client_email: c.contact.email,
        adresse: c.contact.adresse,
        commune: c.contact.commune,
        nature: c.nature,
        date_souhaitee: c.dateSouhaitee,
        resume: c.resume,
        boite: mail.boite,
        mail_message_id: mail.messageId,
      })
      .select('*')
      .single(),
    'Création intervention'
  ) as Intervention;
  const reference = referenceIntervention(cree.id, type, new Date().getFullYear());
  verifier(await sb.from('interventions').update({ reference }).eq('id', cree.id), 'Référence intervention');
  return { ...cree, reference };
}

export type NouvelleDemande = {
  type: 'intervention' | 'devis';
  societe: string;
  urgence: 'urgente' | 'normale';
  client_nom: string;
  client_telephone: string;
  client_email: string;
  adresse: string;
  commune: string;
  nature: string;
  date_souhaitee: string;
};

/** Demande saisie à la main au bureau : pas de mail d'origine, statut « à planifier ». */
export async function creerInterventionManuelle(d: NouvelleDemande): Promise<Intervention> {
  const cree = verifier(
    await sb
      .from('interventions')
      .insert({ ...d, statut: 'a_planifier', resume: d.nature, boite: 'saisie-bureau', mail_message_id: `saisie-${Date.now()}` })
      .select('*')
      .single(),
    'Création manuelle'
  ) as Intervention;
  const reference = referenceIntervention(cree.id, d.type, new Date().getFullYear());
  verifier(await sb.from('interventions').update({ reference }).eq('id', cree.id), 'Référence intervention');
  return { ...cree, reference };
}

export async function majIntervention(id: number, champs: Partial<Omit<Intervention, 'id'>>): Promise<Intervention> {
  return verifier(
    await sb.from('interventions').update({ ...champs, maj_le: new Date().toISOString() }).eq('id', id).select('*').single(),
    'Mise à jour intervention'
  ) as Intervention;
}

/** Intervention dont ce mail est la réponse à notre demande de coordonnées (en-têtes de
 *  réponse : fiable). */
export async function interventionParReponse(mail: MailRecu): Promise<Intervention | null> {
  const ids = [mail.inReplyTo, ...mail.references].filter((x): x is string => !!x);
  if (ids.length === 0) return null;
  const data = verifier(await sb.from('interventions').select('*').in('relance_message_id', ids).limit(1), 'Recherche intervention liée');
  return data && data.length > 0 ? (data[0] as Intervention) : null;
}

/** Demande déjà ouverte dans la même conversation (un mail du fil, client ou collègue, a déjà
 *  donné une fiche) : une réponse dans le fil ne doit jamais créer une seconde fiche. */
export async function interventionDuFil(mail: MailRecu, internes: string[] = []): Promise<Intervention | null> {
  const ids = [mail.inReplyTo, ...mail.references].filter((x): x is string => !!x);
  if (ids.length === 0) return interventionParSujet(mail, internes);
  const parFiche = verifier(await sb.from('interventions').select('*').in('mail_message_id', ids).limit(1), 'Recherche fil (fiche)');
  if (parFiche && parFiche.length > 0) return parFiche[0] as Intervention;
  const parJournal = verifier(
    await sb.from('secretariat_journal').select('intervention_id').in('message_id', ids).not('intervention_id', 'is', null).limit(1),
    'Recherche fil (journal)'
  ) as { intervention_id: number }[];
  if (parJournal && parJournal.length > 0) return interventionParId(parJournal[0].intervention_id);
  return interventionParSujet(mail, internes);
}

/** « Re: URGENT MAX IMMOBILIER » → « urgent max immobilier ». */
export function sujetSansPrefixe(sujet: string): string {
  return sujetNormalise(sujet.replace(/^\s*((re|tr|fw|fwd|r|aw|wg)\s*(\[\d+\])?\s*:\s*)+/i, ''));
}

/** Filet de sécurité quand les en-têtes de réponse manquent (certaines messageries les
 *  perdent) : un « Re: » / « TR: » dont le sujet correspond à une demande encore ouverte des
 *  14 derniers jours, échangé avec le même client ou par un collègue, est la même conversation. */
async function interventionParSujet(mail: MailRecu, internes: string[]): Promise<Intervention | null> {
  if (!/^\s*(re|tr|fw|fwd|r|aw|wg)\s*(\[\d+\])?\s*:/i.test(mail.sujet)) return null;
  const base = sujetSansPrefixe(mail.sujet);
  if (base.length < 6) return null; // « Re: devis » est trop vague pour conclure
  const depuis = new Date(Date.now() - 14 * 86_400_000).toISOString();
  const lignes = verifier(
    await sb
      .from('secretariat_journal')
      .select('sujet, expediteur_adresse, intervention_id')
      .not('intervention_id', 'is', null)
      .gte('recu_le', depuis)
      .order('recu_le', { ascending: false }),
    'Recherche fil (sujet)'
  ) as { sujet: string; expediteur_adresse: string; intervention_id: number }[];
  const interne = (a: string) => estInterne(a, internes);
  const moi = mail.deAdresse.toLowerCase();
  for (const l of lignes ?? []) {
    if (sujetSansPrefixe(l.sujet) !== base) continue;
    if (l.expediteur_adresse !== moi && !interne(moi) && !interne(l.expediteur_adresse)) continue;
    const i = await interventionParId(l.intervention_id);
    if (i && i.statut !== 'realisee' && i.statut !== 'annulee') return i;
  }
  return null;
}

/** Dernière demande du même expéditeur encore en attente de coordonnées (15 jours). À n'utiliser
 *  que si le mail est bien un complément : un bailleur envoie souvent plusieurs bons distincts. */
export async function interventionParExpediteur(mail: MailRecu): Promise<Intervention | null> {
  const depuis = new Date(Date.now() - 15 * 86_400_000).toISOString();
  const data = verifier(
    await sb
      .from('interventions')
      .select('*')
      .eq('statut', 'coordonnees_demandees')
      .ilike('client_email', mail.deAdresse)
      .gte('cree_le', depuis)
      .order('cree_le', { ascending: false })
      .limit(1),
    'Recherche intervention par expéditeur'
  );
  return data && data.length > 0 ? (data[0] as Intervention) : null;
}

export async function interventionParReference(reference: string): Promise<Intervention | null> {
  const data = verifier(await sb.from('interventions').select('*').eq('reference', reference).maybeSingle(), 'Lecture intervention');
  return (data as Intervention) ?? null;
}

/** Expéditeur du mail à l'origine d'une fiche (journal). */
export async function expediteurDe(i: Intervention): Promise<{ adresse: string; nom: string } | null> {
  const data = verifier(
    await sb.from('secretariat_journal').select('expediteur, expediteur_adresse').eq('message_id', i.mail_message_id).limit(1).maybeSingle(),
    'Lecture journal'
  ) as { expediteur: string; expediteur_adresse: string } | null;
  return data ? { adresse: data.expediteur_adresse, nom: data.expediteur.replace(/\s*<.*>$/, '') } : null;
}

export async function interventionParId(id: number): Promise<Intervention | null> {
  const data = verifier(await sb.from('interventions').select('*').eq('id', id).maybeSingle(), 'Lecture intervention');
  return (data as Intervention) ?? null;
}

/** Une réponse automatique est-elle déjà partie vers cette adresse dans les dernières heures ? */
export async function reponseRecente(adresse: string, heures = 12): Promise<boolean> {
  const depuis = new Date(Date.now() - heures * 3_600_000).toISOString();
  const data = verifier(
    await sb
      .from('secretariat_envois')
      .select('id')
      .ilike('destinataire', adresse)
      .in('type', ['accuse_intervention', 'accuse_devis', 'demande_coordonnees'])
      .eq('simulation', false)
      .gte('envoye_le', depuis)
      .limit(1),
    'Lecture envois'
  );
  return (data ?? []).length > 0;
}

export async function noterEnvoi(e: {
  journalId: number | null;
  type: string;
  destinataire: string;
  sujet: string;
  messageId: string | null;
  simulation: boolean;
  cle?: string;
}): Promise<void> {
  verifier(
    await sb.from('secretariat_envois').insert({
      journal_id: e.journalId,
      type: e.type,
      destinataire: e.destinataire.toLowerCase(),
      sujet: e.sujet,
      message_id: e.messageId,
      simulation: e.simulation,
      cle: e.cle ?? null,
    }),
    'Écriture envoi'
  );
}

export async function interventionsOuvertes(): Promise<Intervention[]> {
  return verifier(
    await sb
      .from('interventions')
      .select('*')
      .in('statut', ['coordonnees_demandees', 'a_planifier', 'planifiee'])
      .order('urgence', { ascending: false })
      .order('cree_le', { ascending: true }),
    'Lecture interventions'
  ) as Intervention[];
}

export async function interventionsEntre(debut: Date, fin: Date): Promise<Intervention[]> {
  return verifier(
    await sb.from('interventions').select('*').gte('cree_le', debut.toISOString()).lt('cree_le', fin.toISOString()).order('cree_le'),
    'Lecture interventions du jour'
  ) as Intervention[];
}

export type JournalLu = {
  id: number;
  boite: string;
  recu_le: string;
  expediteur: string;
  expediteur_adresse: string;
  sujet: string;
  categorie: string | null;
  societe: string | null;
  urgence: string | null;
  resume: string | null;
  actions: ActionExecutee[];
  statut: string;
  erreur: string | null;
  intervention_id: number | null;
  fichiers: string[];
  traite_le: string;
};

export async function journalEntre(debut: Date, fin: Date): Promise<JournalLu[]> {
  return verifier(
    await sb.from('secretariat_journal').select('*').gte('recu_le', debut.toISOString()).lt('recu_le', fin.toISOString()).order('recu_le'),
    'Lecture journal du jour'
  ) as JournalLu[];
}

export async function chercherJournal(recherche: string, limite = 200): Promise<JournalLu[]> {
  let requete = sb.from('secretariat_journal').select('*').order('recu_le', { ascending: false }).limit(limite);
  const q = recherche.trim().replace(/[%,()]/g, ' ');
  if (q) requete = requete.or(`expediteur.ilike.%${q}%,sujet.ilike.%${q}%,resume.ilike.%${q}%,boite.ilike.%${q}%`);
  return verifier(await requete, 'Recherche journal') as JournalLu[];
}

/** Rappel déjà envoyé pour ce rendez-vous (clé = identifiant iCal + date) ? Les envois simulés
 *  ne comptent pas : passer en mode réel ne doit pas sauter un rappel. */
export async function rappelDejaEnvoye(cle: string): Promise<boolean> {
  const data = verifier(
    await sb.from('secretariat_envois').select('id').eq('type', 'rappel_rdv').eq('cle', cle).eq('simulation', false).limit(1),
    'Lecture rappels'
  );
  return (data ?? []).length > 0;
}

/** Adresse mail d'un client retrouvée par son téléphone dans les demandes reçues. */
export async function emailParTelephone(tel: string): Promise<string | null> {
  const chiffres = tel.replace(/\D/g, '').slice(-9);
  if (chiffres.length < 9) return null;
  const motif = `%${chiffres.match(/.{1,2}/g)!.join('%')}%`; // tolère « 06 12 34… » comme « 0612… »
  const data = verifier(
    await sb.from('interventions').select('client_email').ilike('client_telephone', motif).neq('client_email', '').order('cree_le', { ascending: false }).limit(1),
    'Recherche client par téléphone'
  ) as { client_email: string }[];
  return data && data.length > 0 ? data[0].client_email : null;
}
