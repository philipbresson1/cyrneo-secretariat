/**
 * Veille d'intervention : pour chaque rendez-vous du planning du lendemain (Sud Assainissement,
 * Multiservices), le BI doit exister et porter la date, sinon il n'entre pas dans le panier des
 * agents. Bon déjà fait → daté ; demande connue sans bon → bon créé ; client reconnu sans
 * demande → son brouillon récent daté, ou un bon créé. Le reste est signalé dans la bulle.
 * Écritures en mode réel seulement.
 */
import type { Classification, Config, Intervention, Societe } from '../logique/types';
import { rdvDesJours, jourParis, type Rdv } from '../lib/agenda';
import { candidats, evident, type Tiers } from '../logique/tiers';
import { depuisParis, jourFr } from '../logique/date-bon';
import { rdvDuClient } from './planning';
import { creerBonIntervention, daterBon } from './dolibarr';
import { indexTiers } from './tiers';
import { publier } from './rainbow';
import * as db from './stockage';

type Journal = (texte: string) => void;

const SOCIETES_VEILLE = ['sud-assainissement', 'multiservices-2a'];
const estRappel = (r: Rdv) => /^\s*(📞|rappel|à rappeler|a rappeler)/i.test(r.titre);
const TEL = /(?:\+33\s?|0)[1-9](?:[\s.-]?\d{2}){4}/;

/** Jours à préparer à partir d'une date : le lendemain, jusqu'au prochain jour ouvré compris
 *  (le vendredi prépare samedi, dimanche et lundi). */
export function joursAPreparer(maintenant: Date): string[] {
  const jours: string[] = [];
  for (let n = 1; n <= 3; n++) {
    const d = new Date(maintenant.getTime() + n * 86_400_000);
    jours.push(jourParis(d));
    const jour = new Date(`${jourParis(d)}T12:00:00Z`).getUTCDay();
    if (jour >= 1 && jour <= 5) break;
  }
  return jours;
}

/** Classification minimale tirée d'un rendez-vous, pour le texte du bon. */
function depuisRdv(r: Rdv, fiche: Intervention | null): Classification {
  const tel = `${r.titre} ${r.description}`.match(TEL)?.[0] ?? '';
  return {
    categorie: 'demande_intervention',
    societe: fiche?.societe ?? '',
    urgence: fiche?.urgence ?? 'normale',
    resume: fiche?.resume || r.description.slice(0, 300),
    nature: fiche?.nature || r.titre,
    dateSouhaitee: '',
    inspectionCamera: false,
    contact: {
      nom: fiche?.client_nom ?? '',
      telephone: fiche?.client_telephone || tel,
      email: fiche?.client_email ?? '',
      adresse: fiche?.adresse || r.lieu || '',
      commune: fiche?.commune ?? '',
    },
  } as Classification;
}

async function tiersDuRdv(r: Rdv, fiche: Intervention | null): Promise<Tiers | null> {
  if (fiche?.dolibarr_tiers_id) {
    const idx = await indexTiers();
    const t = idx.tiers.get(fiche.dolibarr_tiers_id);
    if (t) return t;
  }
  const c = depuisRdv(r, fiche);
  const liste = candidats(
    await indexTiers(),
    { expediteur: '', nom: c.contact.nom, email: c.contact.email, telephone: c.contact.telephone, adresse: c.contact.adresse, commune: c.contact.commune, texte: `${r.titre} ${r.description}` },
    null
  );
  return evident(liste) ? liste[0].tiers : null;
}

async function lireAgenda(url: string): Promise<string | null> {
  try {
    const r = await fetch(url);
    return r.ok ? await r.text() : null;
  } catch {
    return null;
  }
}

export async function preparerBonsDuLendemain(config: Config, log: Journal, jours = joursAPreparer(new Date())): Promise<string[]> {
  const reel = config.mode === 'reel' && config.dolibarr.actif && !!process.env.DOLIBARR_API_KEY;
  const bilan: string[] = [];
  for (const s of config.societes.filter((x) => (config.dolibarr.bonsVeille ?? SOCIETES_VEILLE).includes(x.id) && x.id in config.dolibarr.entites)) {
    const lignes = await preparerSociete(config, s, jours, reel, log);
    if (!lignes.length) continue;
    const texte = [`🗓️ Bons d'intervention du planning (${jours.map((j) => jourFr(depuisParis(`${j}T12:00`))).join(', ')})${reel ? '' : ' — simulation'}`, ...lignes].join('\n');
    bilan.push(`${s.nom}\n${texte}`);
    await publier(reel ? s.bulleRainbow : config.test.bulleRainbow, texte).catch((e) => log(`⚠️ Bilan veille ${s.nom} : ${e instanceof Error ? e.message : String(e)}`));
  }
  return bilan;
}

async function preparerSociete(config: Config, s: Societe, jours: string[], reel: boolean, log: Journal): Promise<string[]> {
  const entite = config.dolibarr.entites[s.id];
  const fiches = await db.fichesOuvertes(s.id);
  const lignes: string[] = [];
  for (const a of config.agendas.filter((x) => x.societe === s.id)) {
    const url = process.env[a.icsEnv];
    const ics = url ? await lireAgenda(url) : null;
    if (!ics) continue;
    for (const j of rdvDesJours(ics, depuisParis(`${jours[0]}T12:00`), jours.length)) {
      for (const r of j.rdvs) {
        if (estRappel(r)) continue;
        const cle = `veille_rdv:${r.uid}:${jourParis(j.date)}`;
        if (reel && (await db.lireSynchro(cle)) !== null) continue; // déjà traité (passe du soir puis du matin)
        const date = r.debut ?? depuisParis(`${jourParis(j.date)}T08:00`);
        const fiche = fiches.find((f) => rdvDuClient(f, r)) ?? null;
        const libelle = r.titre.slice(0, 60);
        try {
          const ligne = await preparerRdv(config, entite, r, fiche, date, reel, log);
          if (ligne) lignes.push(`${ligne} — ${libelle}`);
          if (reel && !ligne?.startsWith('⚠️')) await db.ecrireSynchro(cle, ligne ?? 'ok');
        } catch (e) {
          lignes.push(`⚠️ ${libelle} : ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
  }
  return lignes;
}

/** Une ligne de bilan, ou null quand le bon était déjà prêt. */
async function preparerRdv(config: Config, entite: number, r: Rdv, fiche: Intervention | null, date: Date, reel: boolean, log: Journal): Promise<string | null> {
  const quand = jourFr(date);
  const dater = async (id: number, ref: string) => {
    if (!reel) return `🧪 ${ref} serait daté du ${quand}`;
    const res = await daterBon(config, entite, id, date, fiche?.nature || r.titre);
    if (res === 'deja') return null;
    if (res === 'autre') return `⚠️ ${ref} porte une autre date : à corriger à la main (planning : ${quand})`;
    if (res === 'impossible') return `⚠️ ${ref} n'est plus en brouillon : date à mettre à la main (${quand})`;
    log(`${ref} daté du ${quand} d'après le planning`);
    return `📅 ${ref} daté du ${quand}`;
  };
  const marquer = async () => {
    if (reel && fiche && (fiche.statut !== 'planifiee' || !fiche.date_prevue)) await db.majIntervention(fiche.id, { statut: 'planifiee', date_prevue: date.toISOString() });
  };

  if (fiche?.dolibarr_id && fiche.dolibarr_entite === entite) {
    await marquer();
    return dater(fiche.dolibarr_id, fiche.dolibarr_ref ?? `#${fiche.dolibarr_id}`);
  }
  const tiers = await tiersDuRdv(r, fiche);
  if (!tiers) return `⚠️ client non reconnu avec certitude dans Dolibarr : BI à faire à la main (${quand})`;
  if (!fiche) {
    const [brouillon] = await db.brouillonsDuTiers(entite, tiers.id);
    if (brouillon) return dater(brouillon.id, brouillon.ref);
  }
  const c = depuisRdv(r, fiche);
  if (!reel) return `🧪 BI qui serait créé pour ${tiers.nom}, daté du ${quand}`;
  const bon = await creerBonIntervention(config, entite, tiers.id, c, fiche?.reference ?? `Planning ${quand}`, date);
  if (fiche) {
    await db.majIntervention(fiche.id, { dolibarr_id: bon.id, dolibarr_entite: entite, dolibarr_ref: bon.ref, dolibarr_tiers_id: tiers.id, statut: 'planifiee', date_prevue: date.toISOString() });
  }
  log(`${bon.ref} créé pour ${tiers.nom} d'après le planning (${quand})`);
  return `🧾 ${bon.ref} créé pour ${tiers.nom}, daté du ${quand}`;
}
