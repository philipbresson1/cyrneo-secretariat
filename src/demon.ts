/**
 * Démon de secrétariat — tourne en continu sur le PC du bureau.
 *
 *   npm start                         démarre la boucle H24 + l'écran d'accueil
 *   npm start -- une-fois      un seul passage sur toutes les boîtes, puis s'arrête
 *   npm start -- essai f.eml   trie un mail enregistré, sans rien écrire ni envoyer
 *   npm start -- rapport [AAAA-MM-JJ]   génère l'Excel du jour (ou d'une date)
 *   npm start -- bulles        liste les bulles Rainbow visibles par le compte
 *   npm start -- dolibarr      vérifie l'accès Dolibarr, société par société
 */
import { config as chargerEnv } from 'dotenv';
chargerEnv({ path: '.env.local' });

import { readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { simpleParser } from 'mailparser';
import type { Config } from './logique/types';
import { validerConfig } from './logique/config';
import { raisonDeNePasRepondre } from './logique/garde-fous';
import { decider } from './logique/decision';
import { jourParis } from './lib/agenda';
import { lireNouveaux, convertir } from './services/imap';
import { classer } from './services/classifieur';
import { genererRapport } from './services/rapport-excel';
import { envoyer } from './services/smtp';
import { arreter as arreterRainbow, listerBulles } from './services/rainbow';
import { nomEntite } from './services/dolibarr';
import { demarrerServeur, type Etat } from './services/serveur';
import { ecrireCurseur, lireCurseur, noterEnvoi } from './services/stockage';
import { abandonner, traiterMail } from './traitement';

const ESSAIS_MAX = 3;
const echecs = new Map<string, number>(); // « boîte|uid » → nombre d'échecs

async function chargerConfig(): Promise<Config> {
  const fichier = path.resolve('config.json');
  let texte: string;
  try {
    texte = await readFile(fichier, 'utf8');
  } catch {
    throw new Error(`Fichier ${fichier} absent : copiez config.exemple.json en config.json et complétez-le.`);
  }
  return validerConfig(JSON.parse(texte));
}

function horodatage(): string {
  return new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', dateStyle: 'short', timeStyle: 'medium' }).format(new Date());
}

function log(message: string) {
  console.log(`[${horodatage()}] ${message}`);
}

/** Un passage sur une boîte : lit les nouveaux mails, les traite un par un, avance le curseur. */
async function passerBoite(config: Config, b: Config['boites'][number]): Promise<void> {
  const curseur = await lireCurseur(b.id);
  const depuis = new Date(Date.now() - config.repriseHeures * 3_600_000);
  const lot = await lireNouveaux(b, curseur, depuis);
  let dernierOk = curseur && curseur.uidValidity === lot.uidValidity ? curseur.dernierUid : 0;

  for (const mail of lot.mails) {
    const cle = `${b.id}|${mail.uid}`;
    try {
      const bilan = await traiterMail(mail, b, config);
      log(`${b.id} · ${mail.deAdresse} · « ${mail.sujet} » → ${bilan.statut} · ${bilan.resume}`);
      echecs.delete(cle);
    } catch (e) {
      const n = (echecs.get(cle) ?? 0) + 1;
      echecs.set(cle, n);
      const message = e instanceof Error ? e.message : String(e);
      if (n < ESSAIS_MAX) {
        // On s'arrête là pour cette boîte : le mail sera retenté au prochain passage,
        // et les suivants attendent pour garder l'ordre d'arrivée.
        log(`${b.id} · « ${mail.sujet} » : échec ${n}/${ESSAIS_MAX} (${message}), nouvel essai au prochain passage`);
        break;
      }
      log(`${b.id} · « ${mail.sujet} » : abandon après ${n} échecs (${message}), journalisé en erreur`);
      await abandonner(mail, message);
      echecs.delete(cle);
    }
    dernierOk = mail.uid;
    await ecrireCurseur(b.id, lot.uidValidity, dernierOk);
  }

  if (lot.mails.length === 0) await ecrireCurseur(b.id, lot.uidValidity, lot.dernierUidVu);
}

async function passage(config: Config, etat: Etat): Promise<void> {
  const erreurs: string[] = [];
  for (const b of config.boites) {
    try {
      await passerBoite(config, b);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      erreurs.push(message);
      log(`⚠️ ${message}`);
    }
  }
  etat.dernierPassage = new Date();
  etat.erreurs = erreurs;
}

async function existe(f: string): Promise<boolean> {
  try {
    await access(f);
    return true;
  } catch {
    return false;
  }
}

async function rapportDuJour(config: Config, jour: string): Promise<void> {
  const fichier = await genererRapport(config, jour);
  log(`Rapport Excel écrit : ${fichier}`);
  if (config.rapport.destinataires.length === 0 || config.mode === 'simulation') return;
  const boite = config.boites[0];
  const dest = config.mode === 'test' ? [config.test.adresse] : config.rapport.destinataires;
  const contenu = await readFile(fichier);
  await envoyer({
    boite,
    nomExpediteur: 'Secrétariat CYRNEO',
    a: dest,
    sujet: `Secrétariat — récapitulatif du ${jour.split('-').reverse().join('/')}`,
    texte: "Bonsoir,\n\nVoici le récapitulatif de la journée : interventions et devis demandés, factures reçues, et tout ce qui reste à traiter.\n\nBonne soirée,\nLe secrétariat",
    piecesJointes: [{ nom: path.basename(fichier), type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', taille: contenu.length, contenu }],
    automatique: false,
  });
  await noterEnvoi({ journalId: null, type: 'rapport', destinataire: dest.join(', '), sujet: `Rapport ${jour}`, messageId: null, simulation: false });
}

async function boucle(config: Config): Promise<void> {
  const etat: Etat = { demarreLe: new Date(), dernierPassage: null, erreurs: [], mode: config.mode };
  demarrerServeur(config, etat);
  log(`Secrétariat démarré en mode ${config.mode.toUpperCase()} · ${config.boites.length} boîte(s) · passage toutes les ${config.intervalleMinutes} min`);
  if (config.mode === 'simulation') log('Mode simulation : aucun mail ni message Rainbow ne part. Tout est noté dans le journal.');

  let arret = false;
  const quitter = async () => {
    if (arret) return;
    arret = true;
    log('Arrêt demandé, fin du passage en cours…');
    await arreterRainbow();
    process.exit(0);
  };
  process.on('SIGINT', quitter);
  process.on('SIGTERM', quitter);

  let dernierRapport = '';
  for (;;) {
    const debut = Date.now();
    await passage(config, etat);

    const maintenant = new Date();
    const jour = jourParis(maintenant);
    const heure = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' }).format(maintenant);
    if (heure >= config.rapport.heure.padStart(5, '0') && dernierRapport !== jour) {
      const fichier = path.resolve(config.dossiers.rapports, `Secretariat-${jour}.xlsx`);
      // Après un redémarrage du PC dans la soirée, on ne renvoie pas le rapport déjà fait.
      if (dernierRapport === '' && (await existe(fichier))) dernierRapport = jour;
      else {
        try {
          await rapportDuJour(config, jour);
          dernierRapport = jour;
        } catch (e) {
          log(`⚠️ Rapport Excel : ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }

    const attente = Math.max(10_000, config.intervalleMinutes * 60_000 - (Date.now() - debut));
    await new Promise((r) => setTimeout(r, attente));
  }
}

async function essai(config: Config, fichier: string): Promise<void> {
  const mail = convertir(await simpleParser(await readFile(fichier)), config.boites[0].id, 0);
  const c = await classer(mail, config, null);
  const raison = raisonDeNePasRepondre(mail, config.domainesInternes);
  const actions = decider(mail, c, { config, raisonPasDeReponse: raison, dejaRepondu: false, interventionLiee: null });
  console.log(JSON.stringify({ de: mail.deAdresse, sujet: mail.sujet, classification: c, reponseAuto: raison ?? 'autorisée', actions }, null, 2));
}

async function principal() {
  const [commande = 'demarrer', argument] = process.argv.slice(2);
  const config = await chargerConfig();
  switch (commande) {
    case 'demarrer':
      return boucle(config);
    case 'une-fois': {
      const etat: Etat = { demarreLe: new Date(), dernierPassage: null, erreurs: [], mode: config.mode };
      await passage(config, etat);
      await arreterRainbow();
      process.exit(etat.erreurs.length > 0 ? 1 : 0);
    }
    case 'essai':
      if (!argument) throw new Error('Usage : npm start -- essai chemin/vers/mail.eml');
      return essai(config, argument);
    case 'rapport':
      await rapportDuJour(config, argument ?? jourParis(new Date()));
      return;
    case 'bulles':
      console.log((await listerBulles()).map((b) => `- ${b}`).join('\n') || 'Aucune bulle visible');
      await arreterRainbow();
      process.exit(0);
    case 'dolibarr': {
      // Affiche le nom de chaque entité : c'est ce qui permet de vérifier la correspondance société ↔ numéro.
      for (const [societe, entite] of Object.entries(config.dolibarr.entites)) {
        try {
          console.log(`✓ ${societe} → entité ${entite} : « ${await nomEntite(config, entite)} »`);
        } catch (e) {
          console.log(`✗ ${societe} → entité ${entite} : ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      console.log(config.dolibarr.actif ? 'Création des bons : ACTIVE (mode réel uniquement)' : 'Création des bons : désactivée (dolibarr.actif = false)');
      return;
    }
    default:
      throw new Error(`Commande inconnue « ${commande} » (demarrer, une-fois, essai, rapport, bulles, dolibarr)`);
  }
}

principal().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
