/**
 * Traitement complet d'un mail : tri, décision, exécution selon le mode, journal.
 */
import type { ActionExecutee, Boite, Classification, Config, Intervention, MailRecu, Societe } from './logique/types';
import { raisonDeNePasRepondre } from './logique/garde-fous';
import { choisirBulle } from './logique/decision';
import { imagesSignature } from './logique/signature';
import path from 'node:path';
import { decider, fusionnerContact, societeRetenue } from './logique/decision';
import {
  accuseDevis,
  accuseIntervention,
  demandeCoordonnees,
  messageRainbow,
  messageRainbowComplement,
  messageRainbowRelance,
  messageRainbowVehicule,
  type MailSortant,
} from './logique/modeles';
import { classer } from './services/classifieur';
import { envoyer } from './services/smtp';
import { publier } from './services/rainbow';
import { classerPiecesJointes } from './services/fichiers';
import { creerBonIntervention, entiteDe } from './services/dolibarr';
import { dateDuBon, jourFr } from './logique/date-bon';
import { blocRainbow, reconnaitreTiers, type TiersReconnu } from './services/tiers';
import { saisirFactures } from './services/factures';
import * as db from './services/stockage';

export type Bilan = { statut: 'traite' | 'rien_a_faire' | 'simulation' | 'erreur'; resume: string };

function societe(config: Config, id: string): Societe {
  return config.societes.find((s) => s.id === id) ?? config.societes[0];
}

export async function traiterMail(mail: MailRecu, boite: Boite, config: Config): Promise<Bilan> {
  if (await db.dejaJournalise(mail.boite, mail.messageId)) return { statut: 'rien_a_faire', resume: 'déjà traité' };

  // Doublon d'un mail déjà transformé en demande : noté au journal, rien d'autre (ni tri, ni envoi).
  const double = mail.inReplyTo ? null : await db.demandeEnDouble(mail);
  if (double) {
    await db.journaliser({
      mail,
      classification: null,
      societe: null,
      actions: [{ action: 'creer_intervention', detail: `doublon de ${double.reference}, ignoré`, ok: true, simulee: false }],
      statut: 'rien_a_faire',
      interventionId: double.interventionId,
    });
    return { statut: 'rien_a_faire', resume: `doublon de ${double.reference}` };
  }

  const raison = raisonDeNePasRepondre(mail, config.domainesInternes);
  const interne = raison === 'expéditeur interne au groupe';
  let liee = interne ? null : await db.interventionParReponse(mail);
  const contexte = liee
    ? `ce mail semble répondre à notre demande de coordonnées pour la demande ${liee.reference} (${liee.nature || liee.resume}).`
    : null;

  // Une panne du modèle remonte à l'appelant : le mail n'est pas journalisé et sera retenté.
  let c = await classer(mail, config, contexte);
  let suiteDe: Intervention | null = null;
  // Réponse dans une conversation qui a déjà sa fiche : jamais de seconde fiche.
  if (!liee && ['demande_intervention', 'demande_devis', 'complement_coordonnees', 'relance_client'].includes(c.categorie)) {
    const fil = await db.interventionDuFil(mail, config.domainesInternes);
    if (fil) {
      if (interne) {
        // Échange entre collègues sur une demande déjà suivie : noté, rien d'autre.
        await db.journaliser({
          mail,
          classification: c,
          societe: fil.societe,
          actions: [{ action: 'creer_intervention', detail: `suite de ${fil.reference} (échange interne), pas de nouvelle fiche`, ok: true, simulee: false }],
          statut: 'rien_a_faire',
          interventionId: fil.id,
        });
        return { statut: 'rien_a_faire', resume: `suite interne de ${fil.reference}` };
      }
      // Le client répond dans le fil : il complète ses coordonnées, ou il relance.
      if (fil.statut === 'coordonnees_demandees') liee = fil;
      else {
        c = { ...c, categorie: 'relance_client' };
        suiteDe = fil;
      }
    }
  }
  // Sans en-tête de réponse, on ne rattache à une demande existante que si le modèle y voit
  // un complément de coordonnées : deux bons de travaux du même bailleur restent deux demandes.
  if (!liee && !interne && c.categorie === 'complement_coordonnees') liee = await db.interventionParExpediteur(mail);
  // Une réponse automatique par expéditeur toutes les 12 h, sauf en mode test où l'on enchaîne les essais.
  const dejaRepondu = raison === null && config.mode !== 'test' ? await db.reponseRecente(mail.repondreA) : false;
  const actions = decider(mail, c, { config, raisonPasDeReponse: raison, dejaRepondu, interventionLiee: liee });
  const idSociete = liee?.societe ?? societeRetenue(c, mail, config);
  const s = societe(config, idSociete);
  const simulation = config.mode === 'simulation';

  const faites: ActionExecutee[] = [];
  // La relance d'une demande déjà suivie reste rattachée à sa fiche (journal, Rainbow).
  let intervention: Intervention | null = liee ?? suiteDe;
  const classification: Classification = liee ? fusionnerContact(c, liee) : c;
  let fichiers: string[] = [];
  const envoisANoter: { type: string; destinataire: string; sujet: string; messageId: string | null }[] = [];

  let bonAFaire: string | null = null; // BI que le secrétariat n'a pas pu créer, et pourquoi
  // Tiers Dolibarr de la demande, cherché une seule fois (Rainbow puis bon d'intervention).
  let reconnu: TiersReconnu | null | undefined;
  async function tiers(): Promise<TiersReconnu | null> {
    if (reconnu !== undefined) return reconnu;
    try {
      reconnu = await reconnaitreTiers(config, mail, classification);
      if (reconnu.tiers && intervention && intervention.dolibarr_tiers_id !== reconnu.tiers.id) {
        intervention = await db.majIntervention(intervention.id, { dolibarr_tiers_id: reconnu.tiers.id });
      }
    } catch (e) {
      reconnu = null;
      faites.push({ action: 'bon_dolibarr', detail: `recherche du tiers — ÉCHEC : ${e instanceof Error ? e.message : String(e)}`, ok: false, simulee: false });
    }
    return reconnu;
  }

  async function executer(type: ActionExecutee['action'], simulee: boolean, detail: string, fn: () => Promise<string | void>) {
    if (simulee) {
      faites.push({ action: type, detail: `[simulation] ${detail}`, ok: true, simulee: true });
      return;
    }
    try {
      const plus = await fn();
      faites.push({ action: type, detail: plus ? `${detail} — ${plus}` : detail, ok: true, simulee: false });
    } catch (e) {
      faites.push({ action: type, detail: `${detail} — ÉCHEC : ${e instanceof Error ? e.message : String(e)}`, ok: false, simulee: false });
    }
  }

  for (const a of actions) {
    switch (a.type) {
      case 'creer_intervention': {
        // Toujours créée, même en simulation : c'est ce qui alimente l'écran et l'Excel.
        intervention = await db.creerIntervention(mail, classification, idSociete, a.nature, a.statut);
        faites.push({ action: a.type, detail: `${intervention.reference} (${a.statut})`, ok: true, simulee: false });
        break;
      }
      case 'completer_intervention': {
        intervention = await db.majIntervention(a.interventionId, {
          statut: a.statut,
          client_nom: classification.contact.nom,
          client_telephone: classification.contact.telephone,
          client_email: classification.contact.email,
          adresse: classification.contact.adresse,
          commune: classification.contact.commune,
          nature: classification.nature,
        });
        faites.push({ action: a.type, detail: `${intervention.reference} → ${a.statut}`, ok: true, simulee: false });
        break;
      }
      case 'rainbow': {
        const ref = intervention?.reference ?? '';
        let texte =
          a.gabarit === 'complement' && intervention
            ? `${messageRainbowComplement(mail, classification, s, intervention)}${a.suite !== 'À rappeler pour planifier.' ? `\n⚠️ ${a.suite}` : ''}`
            : a.gabarit === 'vehicule'
              ? messageRainbowVehicule(mail, classification, fichiers)
            : a.gabarit === 'relance' || a.gabarit === 'reclamation'
              ? messageRainbowRelance(mail, classification, s, a.gabarit === 'reclamation' ? `${classification.urgence === 'urgente' ? '🚨' : '⚠️'} Réclamation ${intervention?.reference ?? ''}`.trim() : undefined)
              : messageRainbow(mail, classification, s, ref, a.suite);
        const r = a.gabarit !== 'vehicule' && intervention ? await tiers() : null;
        if (r && r.index.tiers.size > 0) texte += `\n${blocRainbow(r)}`; // copie pas encore faite : rien à dire
        // Le BI des demandes reçues par mail est fait par le secrétariat : le bureau n'en refait pas.
        if (intervention?.dolibarr_ref) texte += `\n🧾 BI ${intervention.dolibarr_ref} créé (brouillon), inutile d'en refaire un`;
        else if (bonAFaire) texte += `\n⚠️ BI à faire dans Dolibarr : ${bonAFaire}`;
        const bulle = choisirBulle(config, s, {
          gabarit: a.gabarit,
          type: intervention?.type ?? 'intervention',
          inspectionCamera: classification.inspectionCamera,
          recuLe: mail.recuLe,
        });
        await executer('rainbow', simulation, `bulle « ${bulle} »`, async () => {
          try {
            await publier(bulle, texte);
          } catch (e) {
            // Rainbow en panne : personne ne doit rater la demande. On prévient par mail.
            if (s.alerteSecours.length > 0) {
              const dest = config.mode === 'test' ? [config.test.adresse] : s.alerteSecours;
              await envoyer({ boite, nomExpediteur: 'Secrétariat CYRNEO', a: dest, sujet: `[Rainbow indisponible] ${mail.sujet}`, texte, automatique: true });
              envoisANoter.push({ type: 'alerte', destinataire: dest.join(', '), sujet: mail.sujet, messageId: null });
              return 'Rainbow indisponible, alerte envoyée par mail';
            }
            throw e;
          }
        });
        break;
      }
      case 'repondre': {
        const ref = intervention?.reference ?? '';
        let m: MailSortant;
        if (a.modele === 'demande_coordonnees') m = demandeCoordonnees(mail, classification, s, a.manquants);
        else if (a.modele === 'accuse_devis') m = accuseDevis(mail, classification, s, ref);
        else m = accuseIntervention(mail, classification, s, ref);
        const destinataire = config.mode === 'test' ? config.test.adresse : mail.repondreA;
        await executer('repondre', simulation, `${a.modele} → ${destinataire}`, async () => {
          const messageId = await envoyer({
            boite,
            nomExpediteur: s.nom,
            a: [destinataire],
            sujet: m.sujet,
            texte: m.texte,
            html: m.html,
            images: imagesSignature(path.resolve('assets/signature')),
            enReponseA: mail.messageId,
            references: mail.references,
            automatique: true,
          });
          envoisANoter.push({ type: a.modele, destinataire: mail.repondreA, sujet: m.sujet, messageId });
          if (a.modele === 'demande_coordonnees' && intervention) {
            intervention = await db.majIntervention(intervention.id, { relance_message_id: messageId });
          }
        });
        if (simulation) envoisANoter.push({ type: a.modele, destinataire: mail.repondreA, sujet: m.sujet, messageId: null });
        break;
      }
      case 'classer_pieces_jointes': {
        // Écrire sur le disque du PC n'a rien de risqué : fait même en simulation.
        try {
          fichiers = await classerPiecesJointes(mail, idSociete, a.dossier === 'vehicules' ? config.dossiers.vehicules : config.dossiers.factures);
          faites.push({ action: a.type, detail: `${fichiers.length} fichier(s) classé(s)`, ok: true, simulee: false });
        } catch (e) {
          faites.push({ action: a.type, detail: `ÉCHEC : ${e instanceof Error ? e.message : String(e)}`, ok: false, simulee: false });
        }
        break;
      }
      case 'bon_dolibarr': {
        if (!intervention) break;
        const inter = intervention;
        // Dolibarr n'a pas de bac à sable : rien n'y est écrit hors du mode réel.
        await executer('bon_dolibarr', config.mode !== 'reel', `bon d'intervention ${s.nom}`, async () => {
          const r = await tiers();
          // Jamais de tiers créé automatiquement : sans tiers reconnu, le bureau fait le bon.
          if (!r?.tiers) {
            bonAFaire = 'tiers non reconnu avec certitude';
            throw new Error('tiers non reconnu avec certitude, bon à faire à la main');
          }
          const entite = entiteDe(config, inter.societe);
          const date = dateDuBon(classification, mail.recuLe);
          const bon = await creerBonIntervention(config, entite, r.tiers.id, classification, inter.reference, date);
          intervention = await db.majIntervention(inter.id, {
            dolibarr_ref: bon.ref,
            dolibarr_id: bon.id,
            dolibarr_entite: entite,
            ...(date && !inter.date_prevue ? { date_prevue: date.toISOString() } : {}),
          });
          return `${bon.ref} (brouillon) pour ${r.tiers.nom}${date ? `, intervention le ${jourFr(date)}` : ', date à fixer (posée la veille d’après le planning)'}`;
        });
        if (config.mode === 'reel' && !intervention?.dolibarr_ref) bonAFaire ??= 'Dolibarr a refusé la création (voir le journal)';
        break;
      }
      case 'facture_dolibarr': {
        const bulle = config.mode === 'test' ? config.test.bulleRainbow : config.bulles.admin;
        await executer('facture_dolibarr', simulation, 'factures fournisseurs', async () => {
          const lignes = await saisirFactures(config, mail);
          if (lignes.length === 0) return 'aucune facture fournisseur dans les PDF';
          if (bulle) await publier(bulle, [`📥 ${mail.deNom || mail.deAdresse} · ${mail.sujet}`, ...lignes].join('\n'));
          return lignes.map((l) => l.split('\n')[0]).join(' | ');
        });
        break;
      }
      case 'transferer': {
        const vers = config.mode === 'test' ? [config.test.adresse] : a.vers;
        const entete = [
          `Transfert automatique du secrétariat — ${classification.categorie.replace(/_/g, ' ')} · ${s.nom}`,
          classification.resume,
          `De : ${mail.deNom ? `${mail.deNom} <${mail.deAdresse}>` : mail.deAdresse} · reçu sur ${mail.boite}`,
          '',
          '---------- Message d’origine ----------',
          '',
        ].join('\n');
        await executer('transferer', simulation, `→ ${vers.join(', ')}`, async () => {
          await envoyer({ boite, nomExpediteur: 'Secrétariat CYRNEO', a: vers, sujet: `TR: ${mail.sujet}`, texte: entete + mail.texte, piecesJointes: mail.piecesJointes, automatique: false });
          envoisANoter.push({ type: 'transfert', destinataire: vers.join(', '), sujet: mail.sujet, messageId: null });
        });
        break;
      }
    }
  }

  const echec = faites.find((f) => !f.ok);
  const statut: Bilan['statut'] = echec ? 'erreur' : actions.length === 0 ? 'rien_a_faire' : simulation ? 'simulation' : 'traite';
  const journalId = await db.journaliser({
    mail,
    classification,
    societe: idSociete,
    actions: faites,
    statut,
    erreur: echec?.detail,
    interventionId: intervention?.id ?? null,
    fichiers,
  });
  for (const e of envoisANoter) await db.noterEnvoi({ journalId, ...e, simulation });

  return {
    statut,
    resume: `${classification.categorie} · ${s.nom}${intervention ? ` · ${intervention.reference}` : ''} · ${faites.map((f) => `${f.action}${f.ok ? '' : ' ✗'}`).join(', ') || 'aucune action'}`,
  };
}

/** Journalise un mail qu'on n'arrive pas à traiter après plusieurs essais, pour ne pas bloquer la boîte. */
export async function abandonner(mail: MailRecu, erreur: string): Promise<void> {
  await db.journaliser({ mail, classification: null, societe: null, actions: [], statut: 'erreur', erreur });
}
