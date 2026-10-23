/**
 * Accès Supabase du secrétariat (clé service-role, PC uniquement).
 */
import { creerClientAdmin } from '../lib/supabase/admin';
import type { ActionExecutee, Classification, Intervention, MailRecu, StatutIntervention } from '../logique/types';
import { referenceIntervention } from '../logique/modeles';

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

/** Vérifie que la base répond et que la clé donne accès aux tables. */
export async function testerBase(): Promise<number> {
  const r = await sb.from('secretariat_journal').select('id', { count: 'exact', head: true });
  if (r.error) throw new Error(r.error.message || 'base injoignable');
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
  type: 'intervention' | 'devis',
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

export async function majIntervention(id: number, champs: Partial<Omit<Intervention, 'id'>>): Promise<Intervention> {
  return verifier(
    await sb.from('interventions').update({ ...champs, maj_le: new Date().toISOString() }).eq('id', id).select('*').single(),
    'Mise à jour intervention'
  ) as Intervention;
}

/** Intervention en attente de coordonnées à laquelle ce mail répond : d'abord par les
 *  en-têtes de réponse (fiable), sinon par l'adresse de l'expéditeur (15 derniers jours). */
export async function trouverInterventionLiee(mail: MailRecu): Promise<Intervention | null> {
  const ids = [mail.inReplyTo, ...mail.references].filter((x): x is string => !!x);
  if (ids.length > 0) {
    const data = verifier(await sb.from('interventions').select('*').in('relance_message_id', ids).limit(1), 'Recherche intervention liée');
    if (data && data.length > 0) return data[0] as Intervention;
  }
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
}): Promise<void> {
  verifier(
    await sb.from('secretariat_envois').insert({
      journal_id: e.journalId,
      type: e.type,
      destinataire: e.destinataire.toLowerCase(),
      sujet: e.sujet,
      message_id: e.messageId,
      simulation: e.simulation,
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
