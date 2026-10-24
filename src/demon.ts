/**
 * Démon de secrétariat — tourne en continu sur le PC du bureau.
 *
 *   npm start                         démarre la boucle H24 + l'écran d'accueil
 *   npm start -- une-fois      un seul passage sur toutes les boîtes, puis s'arrête
 *   npm start -- essai f.eml   trie un mail enregistré, sans rien écrire ni envoyer
 *   npm start -- rapport [AAAA-MM-JJ]   génère l'Excel du jour (ou d'une date)
 *   npm start -- bulles        liste les bulles Rainbow visibles par le compte
 *   npm start -- dolibarr      vérifie l'accès Dolibarr, société par société
 *   npm start -- tiers         recopie maintenant la liste des tiers Dolibarr
 *   npm start -- devis         relie les devis à faire aux propositions Dolibarr, devis acceptés
 *   npm start -- reprise-rainbow "SUD Travaux" 90   devis à faire tirés des anciens posts d'une bulle
 *   npm start -- essai-bon REF bon Dolibarr + message bulle de test pour une fiche existante
 *   npm start -- verifier      teste chaque branchement : base, Claude, boîtes mail, agendas
 *   npm start -- rappels [apercu]   rappels des rendez-vous de demain (apercu : n'envoie rien)
 */
import { config as chargerEnv } from 'dotenv';
const env = chargerEnv({ path: '.env.local', quiet: true });

import { readFile, access, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { simpleParser } from 'mailparser';
import type { Classification, Config, MailRecu } from './logique/types';
import { appliquerEnv, validerConfig } from './logique/config';
import { raisonDeNePasRepondre } from './logique/garde-fous';
import { decider } from './logique/decision';
import { jourParis } from './lib/agenda';
import { lireNouveaux, convertir, testerBoite } from './services/imap';
import { classer } from './services/classifieur';
import { genererRapport } from './services/rapport-excel';
import { envoyer } from './services/smtp';
import { arreter as arreterRainbow, bullesAttendues, ecouterBulles, listerBulles, publier, type MessageBulle } from './services/rainbow';
import { releverBonsDolibarr, releverDevisDolibarr, repriseBulle, traiterMessageBulle } from './services/appels';
import { creerBonIntervention, entiteDe, listerEntites, verifierDroits } from './services/dolibarr';
import { blocRainbow, reconnaitreTiers, synchroDue, synchroniserTiers } from './services/tiers';
import { envoyerRappels, type BilanRappels } from './services/rappels';
import { demarrerServeur, type Etat } from './services/serveur';
import { ecrireCurseur, ecrireSynchro, expediteurDe, lireSynchro, interventionParReference, lireCurseur, majIntervention, noterEnvoi, testerBase } from './services/stockage';
import Anthropic from '@anthropic-ai/sdk';
import { abandonner, traiterMail } from './traitement';

const ESSAIS_MAX = 3;
const echecs = new Map<string, number>(); // « boîte|uid » → nombre d'échecs

/** config.json (réglages propres au PC) s'il existe, sinon config.exemple.json du dépôt : sans
 *  copie locale, chaque mise à jour de nuit apporte aussi la dernière configuration. */
async function chargerConfig(): Promise<Config> {
  for (const nom of ['config.json', 'config.exemple.json']) {
    try {
      return validerConfig(appliquerEnv(JSON.parse(await readFile(path.resolve(nom), 'utf8'))));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }
  throw new Error('Aucun fichier config.json ni config.exemple.json');
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
  let dernierRappel = '';
  let derniereVerifTiers = 0;
  let derniereReleveDevis = 0;

  // Demandes notées dans les bulles : traitées une par une, dans l'ordre d'arrivée.
  // Signe de vie chaque minute : la base alerte (téléphone + mail) s'il manque depuis 15 min.
  const battement = () =>
    ecrireSynchro('battement', JSON.stringify({ mode: config.mode, poste: os.hostname(), depuis: etat.demarreLe.toISOString() })).catch((e) =>
      log(`⚠️ Signe de vie non écrit : ${e instanceof Error ? e.message : String(e)}`)
    );
  void battement();
  setInterval(() => void battement(), 60_000).unref();

  let file: Promise<unknown> = Promise.resolve();
  const surMessage = (m: MessageBulle) => {
    file = file.then(() => traiterMessageBulle(config, m, log)).catch((e) => log(`⚠️ Message Rainbow « ${m.bulle} » : ${e instanceof Error ? e.message : String(e)}`));
  };
  // Bulles des sociétés du bâtiment : c'est là que sont notés les devis à faire. Leurs anciens
  // posts sont relus une fois (90 jours), dans la même file que les messages qui arrivent.
  const bullesDevis = [...new Set((config.ecran.vues ?? []).flatMap((v) => v.societes))]
    .map((id) => config.societes.find((x) => x.id === id)?.bulleRainbow)
    .filter((b): b is string => !!b);
  let repriseLancee = false;
  const dolibarrPret = () => !!config.dolibarr.url && !!process.env.DOLIBARR_API_KEY;

  for (;;) {
    const debut = Date.now();
    await passage(config, etat);

    if (config.mode !== 'simulation') {
      // Ouvre la connexion, ou la rouvre après une coupure.
      const ecoute = await ecouterBulles(surMessage)
        .then(() => true)
        .catch((e) => {
          log(`⚠️ Écoute Rainbow : ${e instanceof Error ? e.message : String(e)}`);
          return false;
        });
      if (ecoute && !repriseLancee) {
        repriseLancee = true;
        for (const nom of bullesDevis) {
          file = file.then(async () => {
            if ((await lireSynchro(`reprise_rainbow:${nom}`)) !== null) return;
            await repriseBulle(config, nom, 90, log);
            await ecrireSynchro(`reprise_rainbow:${nom}`, 'faite');
          }).catch((e) => log(`⚠️ Reprise de « ${nom} » : ${e instanceof Error ? e.message : String(e)}`));
        }
      }
    }
    // Liste des tiers Dolibarr : recopiée chaque semaine (vérifié une fois par heure).
    if (dolibarrPret() && Date.now() - derniereVerifTiers > 3_600_000) {
      derniereVerifTiers = Date.now();
      try {
        if (await synchroDue()) log(`Tiers Dolibarr synchronisés : ${await synchroniserTiers(config)}`);
      } catch (e) {
        log(`⚠️ Synchro des tiers Dolibarr : ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    if (dolibarrPret()) {
      await releverBonsDolibarr(config, log).catch((e) => log(`⚠️ Bons Dolibarr : ${e instanceof Error ? e.message : String(e)}`));
      // Devis (propositions commerciales) : tous les quarts d'heure.
      if (Date.now() - derniereReleveDevis > 15 * 60_000) {
        derniereReleveDevis = Date.now();
        await releverDevisDolibarr(config, log).catch((e) => log(`⚠️ Devis Dolibarr : ${e instanceof Error ? e.message : String(e)}`));
      }
    }

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

    if (config.rappels.actif && heure >= config.rappels.heure.padStart(5, '0') && dernierRappel !== jour) {
      dernierRappel = jour;
      try {
        afficherRappels(await envoyerRappels(config));
      } catch (e) {
        log(`⚠️ Rappels de rendez-vous : ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // Redémarrage de nuit : secretariat.ps1 relance aussitôt le démon après un git pull,
    // ce qui installe les mises à jour sans intervention.
    if (heure.startsWith('03:') && Date.now() - etat.demarreLe.getTime() > 3_600_000) {
      log('Redémarrage de nuit pour mise à jour');
      await arreterRainbow();
      process.exit(0);
    }

    const attente = Math.max(10_000, config.intervalleMinutes * 60_000 - (Date.now() - debut));
    await new Promise((r) => setTimeout(r, attente));
  }
}

function afficherRappels(b: BilanRappels): void {
  log(`Rappels de rendez-vous : ${b.envoyes.length} envoyé(s), ${b.sansEmail} sans adresse mail, ${b.ignores} hors client, ${b.deja} déjà envoyé(s), ${b.suites} chantier(s) déjà en cours la veille`);
  for (const l of b.envoyes) log(`  ✉️ ${l}`);
  for (const l of b.erreurs) log(`  ⚠️ ${l}`);
}

async function essai(config: Config, fichier: string): Promise<void> {
  const mail = convertir(await simpleParser(await readFile(fichier)), config.boites[0].id, 0);
  const c = await classer(mail, config, null);
  const raison = raisonDeNePasRepondre(mail, config.domainesInternes);
  const actions = decider(mail, c, { config, raisonPasDeReponse: raison, dejaRepondu: false, interventionLiee: null });
  console.log(JSON.stringify({ de: mail.deAdresse, sujet: mail.sujet, classification: c, reponseAuto: raison ?? 'autorisée', actions }, null, 2));
}

async function verifier(config: Config): Promise<void> {
  const ligne = async (nom: string, test: () => Promise<string>) => {
    try {
      console.log(`✓ ${nom} : ${await test()}`);
    } catch (e) {
      console.log(`✗ ${nom} : ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  console.log(`Mode ${config.mode.toUpperCase()}\n`);
  if (env.error) {
    // Cas classique sous Windows : le Bloc-notes enregistre « .env.local.txt ».
    const presents = (await readdir('.')).filter((f) => f.startsWith('.env') || f.toLowerCase().includes('env.local'));
    console.log(`✗ Fichier .env.local introuvable dans ${path.resolve('.')}. Fichiers trouvés : ${presents.join(', ') || 'aucun'}`);
    console.log('  Si vous voyez « .env.local.txt », renommez-le : ren .env.local.txt .env.local\n');
  } else {
    console.log(`✓ Fichier .env.local : ${Object.keys(env.parsed ?? {}).length} variable(s) lue(s)`);
    // Pièges courants : une variable collée deux fois (la dernière l'emporte) ou laissée à « xxxx ».
    const vues = new Map<string, number>();
    for (const l of (await readFile('.env.local', 'utf8')).split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=/.exec(l);
      if (m) vues.set(m[1], (vues.get(m[1]) ?? 0) + 1);
    }
    for (const [cle, n] of vues) if (n > 1) console.log(`⚠ ${cle} apparaît ${n} fois : seule la dernière ligne compte, supprimez les autres`);
    for (const [cle, val] of Object.entries(env.parsed ?? {})) if (/x{4}/i.test(val)) console.log(`⚠ ${cle} contient encore « xxxx » (valeur du modèle à remplacer)`);
    console.log('');
  }
  await ligne('Base Supabase', async () => {
    if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE) throw new Error('NEXT_PUBLIC_SUPABASE_URL ou SUPABASE_SERVICE_ROLE absente de .env.local');
    return `${await testerBase()} mail(s) déjà au journal`;
  });
  await ligne('Claude (tri des mails)', async () => {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY absente de .env.local');
    const m = await new Anthropic().models.retrieve(config.modele);
    return `clé valide, modèle ${m.id}`;
  });
  for (const b of config.boites) await ligne(`Boîte ${b.adresse}`, async () => `${await testerBoite(b)} mail(s) dans la boîte de réception`);
  for (const a of config.agendas) {
    await ligne(`Agenda ${a.nom}`, async () => {
      const url = process.env[a.icsEnv];
      if (!url) throw new Error(`${a.icsEnv} absente de .env.local`);
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return `${((await r.text()).match(/BEGIN:VEVENT/g) ?? []).length} événement(s)`;
    });
  }
}

/** Test de bout en bout sur une fiche existante : bon d'intervention Dolibarr (brouillon) et
 *  message dans la bulle de test. Écrit dans Dolibarr même si dolibarr.actif = false. */
async function essaiBon(config: Config, reference: string) {
  const fiche = await interventionParReference(reference);
  if (!fiche) throw new Error(`Aucune fiche ${reference} dans la base`);
  const s = config.societes.find((x) => x.id === fiche.societe);
  if (!s) throw new Error(`Société inconnue : ${fiche.societe}`);
  const c: Classification = {
    categorie: 'demande_intervention',
    societe: fiche.societe,
    urgence: fiche.urgence,
    resume: fiche.resume,
    nature: fiche.nature,
    dateSouhaitee: fiche.date_souhaitee,
    inspectionCamera: false,
    contact: { nom: fiche.client_nom, telephone: fiche.client_telephone, email: fiche.client_email, adresse: fiche.adresse, commune: fiche.commune },
  };
  const entite = entiteDe(config, fiche.societe);
  console.log(`${reference} · ${s.nom} → entité Dolibarr ${entite}`);
  if (await synchroDue()) console.log(`Tiers Dolibarr synchronisés : ${await synchroniserTiers(config)}`);
  const de = await expediteurDe(fiche);
  const mail = { deAdresse: de?.adresse ?? fiche.client_email, deNom: de?.nom ?? '' } as MailRecu;
  const r = await reconnaitreTiers(config, mail, c);
  console.log(blocRainbow(r));
  let ligneBon = 'Pas de bon : tiers non reconnu avec certitude (aucun tiers n’est créé automatiquement)';
  if (r.tiers) {
    const bon = await creerBonIntervention(config, entite, r.tiers.id, c, reference);
    await majIntervention(fiche.id, { dolibarr_ref: bon.ref, dolibarr_id: bon.id, dolibarr_entite: entite, dolibarr_tiers_id: r.tiers.id });
    ligneBon = `Bon ${bon.ref} créé en brouillon\n${config.dolibarr.url}/fichinter/card.php?id=${bon.id}`;
  }
  console.log(ligneBon);
  const texte = [
    `🧪 Test Dolibarr — ${s.nom} · ${reference}`,
    `${[fiche.adresse, fiche.commune].filter(Boolean).join(', ')} · ${fiche.nature}`,
    blocRainbow(r),
    ligneBon,
  ].join('\n');
  await publier(config.test.bulleRainbow, texte);
  console.log(`✓ Message publié dans « ${config.test.bulleRainbow} »`);
  await arreterRainbow();
  process.exit(0);
}

async function principal() {
  const [commande = 'demarrer', argument] = process.argv.slice(2);
  const config = await chargerConfig();
  bullesAttendues([
    ...config.societes.flatMap((s) => [s.bulleRainbow, s.bulleUrgence ?? '', s.bulleInspection ?? '']),
    config.bulles.vehicules,
    config.bulles.admin ?? '',
    config.test.bulleRainbow,
  ]);
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
    case 'verifier':
      return verifier(config);
    case 'rappels':
      afficherRappels(await envoyerRappels(config, new Date(), argument === 'apercu'));
      return;
    case 'reprise-rainbow': {
      // npm start -- reprise-rainbow "SUD Travaux" 90
      const [, , nom, jours = '90'] = process.argv.slice(2);
      if (!nom) throw new Error('Usage : npm start -- reprise-rainbow "Nom de la bulle" [jours]');
      await repriseBulle(config, nom, Number(jours) || 90, (t) => console.log(t));
      await arreterRainbow();
      process.exit(0);
    }
    case 'devis':
      if (await synchroDue()) console.log(`Tiers Dolibarr synchronisés : ${await synchroniserTiers(config)}`);
      await releverDevisDolibarr(config, (t) => console.log(t));
      console.log('Devis Dolibarr relevés.');
      return;
    case 'tiers':
      console.log(`Synchronisation des tiers Dolibarr… ${await synchroniserTiers(config)}`);
      return;
    case 'essai-bon':
      return essaiBon(config, argument ?? 'INT-2026-0006');
    case 'dolibarr': {
      console.log(`Dolibarr : ${config.dolibarr.url}\n`);
      let noms = new Map<number, string>();
      try {
        const entites = await listerEntites(config);
        if (entites) {
          console.log('Sociétés déclarées dans Dolibarr (numéro d’entité → nom) :');
          for (const x of entites) console.log(`  ${x.id} → ${x.nom}`);
          noms = new Map(entites.map((x) => [x.id, x.nom]));
          console.log('');
        }
      } catch (e) {
        console.log(`✗ Connexion Dolibarr : ${e instanceof Error ? e.message : String(e)}\n`);
      }
      // Nom de l'entité en face de chaque société : c'est ce qui permet de vérifier la correspondance.
      for (const [societe, entite] of Object.entries(config.dolibarr.entites)) {
        try {
          await verifierDroits(config, entite);
          console.log(`✓ ${societe} → entité ${entite} « ${noms.get(entite) ?? '?'} » : tiers et interventions accessibles`);
        } catch (e) {
          console.log(`✗ ${societe} → entité ${entite} : ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      console.log(config.dolibarr.actif ? 'Création des bons : ACTIVE (mode réel uniquement)' : 'Création des bons : désactivée (dolibarr.actif = false)');
      return;
    }
    default:
      throw new Error(`Commande inconnue « ${commande} » (demarrer, une-fois, essai, essai-bon, tiers, devis, reprise-rainbow, rapport, bulles, dolibarr, verifier, rappels)`);
  }
}

principal().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
