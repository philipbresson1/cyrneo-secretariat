/**
 * Relecture des factures émises : une vidange de fosse facturée → proposition de contrat
 * d'entretien sur deux ans (la vidange vient d'être faite, le contrat finance la prochaine).
 *
 * Pas d'onglet commercial dans l'outil. Chaque proposition émise :
 *  - contrat Sud Assainissement en brouillon dans Dolibarr (module Contrats), contrat type et
 *    mandat SEPA pré-remplis joints au contrat ;
 *  - mail au bureau (info@ et commercial@) avec le fichier « Relances contrats » (à faire,
 *    conversion, CA potentiel, CA signé, volume), le contrat et le mandat.
 * Rien ne part chez le client : le commercial transmet. Un contrat validé dans Dolibarr compte
 * comme signé. Écritures en mode réel seulement.
 */
import ExcelJS from 'exceljs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import type { Config, PieceJointe } from '../logique/types';
import { ligneContrat, ligneVidangeFosse, MOIS_CONTRAT, prixContrat, secteurDe, volumeDe, type Grille } from '../logique/contrat';
import { contratDocx, mandatDocx, rum, type DonneesContrat } from '../logique/contrat-docs';
import { imagesSignature, mailHtml, SIGNATURE_TEXTE } from '../logique/signature';
import { estSyndic } from '../logique/tiers';
import { contratActif, creerContratBrouillon, deposerDocument, lireFacturesEmises, statutContrat, type FactureEmise } from './dolibarr';
import { indexTiers, tiersParId } from './tiers';
import { publier } from './rainbow';
import { envoyer } from './smtp';
import * as db from './stockage';

type Journal = (texte: string) => void;
type Documents = { contrat: PieceJointe; mandat: PieceJointe };

const SOCIETES_CONTRAT = ['sud-assainissement'];
const DESTINATAIRES = ['info@groupecyrneo.com', 'commercial@groupecyrneo.com'];
const DOCS_PAR_MAIL = 10; // au-delà (premier relevé), les documents sont sur chaque contrat Dolibarr
const site = () => (process.env.SITE_SA_URL || 'https://www.sud-assainissement-ajaccio.com').replace(/\/$/, '');
const euros = (n: number) => `${n.toFixed(2).replace('.', ',')} €`;
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const totalDe = (c: db.ContratPropose) => Number(c.total_ttc ?? Number(c.mensualite ?? 0) * MOIS_CONTRAT);

let grille: { valeur: Grille; le: number } | null = null;

/** La grille tarifaire du site (js/grille.js), seule source des prix ; relue toutes les 6 h. */
export async function chargerGrille(): Promise<Grille> {
  if (grille && Date.now() - grille.le < 6 * 3_600_000) return grille.valeur;
  const r = await fetch(`${site()}/js/grille.js`);
  if (!r.ok) throw new Error(`grille tarifaire du site : HTTP ${r.status}`);
  const module = { exports: {} as Grille };
  vm.runInNewContext(await r.text(), { module, self: {} }, { timeout: 1000 });
  if (!module.exports.GRILLE) throw new Error('grille tarifaire du site illisible');
  grille = { valeur: module.exports, le: Date.now() };
  return module.exports;
}

/** En mode test, rien n'est enregistré : les propositions vivent le temps du passage. */
let simulation: db.ContratPropose[] = [];

export async function relireFacturesEmises(config: Config, log: Journal, options: { forcerMail?: boolean } = {}): Promise<string[]> {
  const reel = config.mode === 'reel' && config.dolibarr.actif;
  simulation = [];
  const g = await chargerGrille();
  const modele = await readFile(path.resolve('assets/contrats/contrat-fosse.docx'));
  const bilan: string[] = [];

  for (const societe of config.contrats?.societes ?? SOCIETES_CONTRAT) {
    const entite = config.dolibarr.entites[societe];
    if (!entite) continue;
    const curseur = `factures_emises:${entite}`;
    const depuis = await db.lireSynchro(curseur);
    const debut = new Date();
    // Premier relevé : onze mois en arrière (au-delà d'un an, ce serait un pack, pas un contrat seul).
    const factures = await lireFacturesEmises(config, entite, depuis ? new Date(depuis) : null, new Date(Date.now() - 330 * 86_400_000));
    for (const f of factures) {
      if (!f.socid || !f.lignes.some((l) => ligneVidangeFosse(l.texte)) || f.lignes.some((l) => ligneContrat(l.texte))) continue;
      if (Date.now() - f.date.getTime() > 365 * 86_400_000) continue;
      if (await db.contratDejaPropose(entite, f.socid, f.id)) continue;
      if (simulation.some((x) => x.tiers_id === f.socid)) continue;
      if ((await contratActif(config, entite, f.socid)) === true) continue;
      const ligne = await nouvelle(config, g, entite, f, reel);
      if (ligne) bilan.push(ligne);
    }
    if (reel) await db.ecrireSynchro(curseur, debut.toISOString());
  }

  const enCours = () => (reel ? db.contratsProposes() : Promise.resolve(simulation));
  // Fiche client corrigée depuis (commune) : la proposition « à compléter » devient émettable.
  if (reel) {
    for (const c of await enCours()) {
      if (c.statut !== 'a_completer') continue;
      const maj = await reevaluer(config, g, c);
      if (maj) await db.majContratPropose(c.id, maj);
    }
  }
  const documents: Documents[] = [];
  for (const c of await enCours()) {
    if (c.statut !== 'pret') continue;
    try {
      documents.push(await emettre(config, modele, c, reel, log));
    } catch (e) {
      log(`⚠️ Contrat ${c.client_nom} : ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const signes = reel ? await suivreSignatures(config, log) : 0;

  const lundi = new Date().toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris', weekday: 'long' }) === 'lundi';
  if (documents.length || signes || lundi || options.forcerMail) await envoyerAuBureau(config, await enCours(), documents, signes, reel);
  if (documents.length && config.bulles.admin) {
    const texte = `📄 ${documents.length} proposition${documents.length > 1 ? 's' : ''} de contrat d'entretien (vidange facturée) en brouillon dans Dolibarr. Fichier Relances contrats, contrats et mandats envoyés à info@ et commercial@.`;
    await publier(reel ? config.bulles.admin : config.test.bulleRainbow, texte).catch((e) => log(`⚠️ Bilan contrats : ${e instanceof Error ? e.message : String(e)}`));
  }
  return bilan;
}

/** Proposition tirée d'une facture : « à compléter » (secteur inconnu, syndic) ou « à émettre ». */
async function nouvelle(config: Config, g: Grille, entite: number, f: FactureEmise, reel: boolean): Promise<string | null> {
  const t = await tiersParId(config, entite, f.socid);
  if (!t || !t.actif) return null;
  const secteur = secteurDe(t.ville, t.adresse, g);
  const v = volumeDe(f.lignes, secteur, g);
  const volume = v.volume ?? 3; // comme le site quand on ne sait pas : 3 m³
  const syndic = estSyndic(await indexTiers(), t);
  const prix = secteur && !syndic ? prixContrat(g, secteur, volume, v.accesLoin) : null;
  const note = [
    !v.volume && 'volume non précisé sur la facture : 3 m³ par défaut, à confirmer',
    syndic && 'client syndic : contrat sur mesure',
    !secteur && `secteur de « ${t.ville || 'commune inconnue'} » à préciser dans la fiche client`,
  ]
    .filter(Boolean)
    .join(' · ');
  const ligne: Omit<db.ContratPropose, 'id' | 'cree_le'> = {
    entite, facture_id: f.id, facture_ref: f.ref, facture_le: f.date.toISOString(), tiers_id: t.id,
    client_nom: t.nom, email: t.email, telephone: t.telephone, adresse: t.adresse, cp: t.cp, ville: t.ville,
    secteur, volume, acces_loin: v.accesLoin, vidange_ttc: prix?.vidange ?? null, mensualite: prix?.mensualite ?? null,
    statut: prix ? 'pret' : 'a_completer', lien: null, note,
    dolibarr_contrat_id: null, dolibarr_contrat_ref: null, rum: null, total_ttc: null, emis_le: null, signe_le: null,
  };
  if (reel) await db.ajouterContratPropose(ligne);
  else simulation.push({ ...ligne, id: -simulation.length - 1, cree_le: new Date().toISOString() });
  return `${t.nom} (${f.ref}) : ${prix ? `${volume} m³ ${secteur} → ${euros(prix.mensualite)}/mois` : note}`;
}

async function reevaluer(config: Config, g: Grille, c: db.ContratPropose): Promise<Partial<db.ContratPropose> | null> {
  if (c.note.includes('syndic')) return null;
  const t = await tiersParId(config, c.entite, c.tiers_id);
  const secteur = t ? secteurDe(t.ville, t.adresse, g) : null;
  if (!t || !secteur) return null;
  const prix = prixContrat(g, secteur, c.volume ?? 3, c.acces_loin);
  return {
    secteur, adresse: t.adresse, cp: t.cp, ville: t.ville, email: t.email, telephone: t.telephone,
    vidange_ttc: prix.vidange, mensualite: prix.mensualite, statut: 'pret',
    note: c.note.split(' · ').filter((n) => !n.startsWith('secteur de')).join(' · '),
  };
}

/** Contrat Dolibarr en brouillon, contrat type et mandat pré-remplis joints. */
async function emettre(config: Config, modele: Buffer, c: db.ContratPropose, reel: boolean, log: Journal): Promise<Documents> {
  const mensualite = Number(c.mensualite ?? 0);
  const vidange = Number(c.vidange_ttc ?? 0);
  let reference = `Proposition après ${c.facture_ref}`;
  let id: number | null = null;
  if (reel) {
    const cr = await creerContratBrouillon(config, c.entite, c.tiers_id, {
      libelle: `Contrat d'entretien fosse septique — vidange tous les 2 ans — ${c.volume} m³, secteur ${c.secteur}${c.acces_loin ? ', accès + 20 m' : ''} — mensualité (vidange ${euros(vidange)} TTC lissée sur ${MOIS_CONTRAT} mois)`,
      mensualiteTtc: mensualite,
      mois: MOIS_CONTRAT,
      note: `Proposé par le secrétariat après la vidange facturée ${c.facture_ref}.${c.note ? ` ${c.note}.` : ''}`,
    });
    reference = cr.ref;
    id = cr.id;
  }
  const d: DonneesContrat = {
    client_nom: c.client_nom, adresse: c.adresse, cp: c.cp, ville: c.ville, telephone: c.telephone, email: c.email,
    secteur: c.secteur ?? '', volume: c.volume ?? 3, acces_loin: c.acces_loin, vidange_ttc: vidange, mensualite, reference, rum: rum(c.client_nom),
  };
  const nom = c.client_nom.replace(/[^\p{L}\d]+/gu, '-').replace(/^-|-$/g, '').slice(0, 40) || 'client';
  const contrat = contratDocx(modele, d);
  const mandat = mandatDocx(d);
  const docs: Documents = {
    contrat: { nom: `Contrat-entretien-${nom}.docx`, type: DOCX, taille: contrat.length, contenu: contrat },
    mandat: { nom: `Mandat-SEPA-${nom}.docx`, type: DOCX, taille: mandat.length, contenu: mandat },
  };
  const emis = { statut: 'emis' as const, dolibarr_contrat_id: id, dolibarr_contrat_ref: reel ? reference : null, rum: d.rum, total_ttc: mensualite * MOIS_CONTRAT, emis_le: new Date().toISOString() };
  if (reel && id) {
    for (const p of [docs.contrat, docs.mandat]) {
      await deposerDocument(config, c.entite, 'contrat', reference, p.nom, p.contenu).catch((e) => log(`⚠️ ${p.nom} non joint au contrat ${reference} : ${e instanceof Error ? e.message : String(e)}`));
    }
    await db.majContratPropose(c.id, emis);
    log(`Contrat ${reference} en brouillon pour ${c.client_nom} (après ${c.facture_ref})`);
  } else Object.assign(c, emis);
  return docs;
}

/** Contrats validés dans Dolibarr → signés ; supprimés → abandonnés. */
async function suivreSignatures(config: Config, log: Journal): Promise<number> {
  let signes = 0;
  for (const c of await db.contratsProposes()) {
    if (c.statut !== 'emis' || !c.dolibarr_contrat_id) continue;
    const s = await statutContrat(config, c.entite, c.dolibarr_contrat_id).catch(() => 0);
    if (s === null) await db.majContratPropose(c.id, { statut: 'abandonne' });
    else if (s >= 1) {
      await db.majContratPropose(c.id, { statut: 'signe', signe_le: new Date().toISOString() });
      log(`Contrat ${c.dolibarr_contrat_ref} signé : ${c.client_nom}`);
      signes++;
    }
  }
  return signes;
}

export type Synthese = { aFaire: number; emises: number; signees: number; ratio: number; caPotentiel: number; caSigne: number; volume: number; volumeM3: number };

const EMISES: db.ContratPropose['statut'][] = ['emis', 'signe', 'abandonne'];

export function synthese(contrats: db.ContratPropose[]): Synthese {
  const vivants = contrats.filter((c) => c.statut !== 'ecarte');
  const emises = vivants.filter((c) => EMISES.includes(c.statut));
  const signees = vivants.filter((c) => c.statut === 'signe');
  return {
    aFaire: vivants.filter((c) => c.statut === 'a_completer' || c.statut === 'pret').length,
    emises: emises.length,
    signees: signees.length,
    ratio: emises.length ? signees.length / emises.length : 0,
    caPotentiel: vivants.filter((c) => c.statut === 'emis' || c.statut === 'pret').reduce((a, c) => a + totalDe(c), 0),
    caSigne: signees.reduce((a, c) => a + totalDe(c), 0),
    volume: vivants.length,
    volumeM3: vivants.reduce((a, c) => a + (c.volume ?? 0), 0),
  };
}

const STATUTS: Record<db.ContratPropose['statut'], string> = { a_completer: 'À compléter', pret: 'À émettre', emis: 'Émis — à relancer', signe: 'Signé', abandonne: 'Abandonné', ecarte: 'Écarté' };

/** Fichier « Relances contrats » : synthèse (et par mois), puis une ligne par proposition. */
export async function fichierRelances(contrats: db.ContratPropose[], maintenant = new Date()): Promise<Buffer> {
  const s = synthese(contrats);
  const classeur = new ExcelJS.Workbook();
  const entete = (r: ExcelJS.Row) => {
    r.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    r.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3A5F' } };
  };
  const syn = classeur.addWorksheet('Synthèse');
  syn.columns = [{ width: 42 }, { width: 16 }, { width: 10 }, { width: 10 }, { width: 12 }, { width: 14 }, { width: 14 }];
  entete(syn.addRow(['Indicateur', 'Valeur']));
  const kpi: [string, number, string?][] = [
    ['Propositions à faire', s.aFaire],
    ['Propositions émises (transmises)', s.emises],
    ['Contrats signés', s.signees],
    ['Ratio de conversion (signés / émises)', s.ratio, '0.0 %'],
    ['CA potentiel TTC (émis et à faire, sur 24 mois)', s.caPotentiel, '#,##0.00 €'],
    ['CA signé TTC (sur 24 mois)', s.caSigne, '#,##0.00 €'],
    ['Volume : propositions', s.volume],
    ['Volume : fosses (m³)', s.volumeM3],
  ];
  for (const [k, v, fmt] of kpi) {
    const r = syn.addRow([k, v]);
    if (fmt) r.getCell(2).numFmt = fmt;
  }
  syn.addRow([]);
  entete(syn.addRow(['Mois de la vidange', 'Propositions', 'Émises', 'Signées', 'Conversion', 'CA potentiel', 'CA signé']));
  const mois = new Map<string, db.ContratPropose[]>();
  for (const c of contrats.filter((x) => x.statut !== 'ecarte')) {
    const m = (c.facture_le ?? c.cree_le).slice(0, 7);
    mois.set(m, [...(mois.get(m) ?? []), c]);
  }
  for (const [m, liste] of [...mois].sort(([a], [b]) => a.localeCompare(b))) {
    const x = synthese(liste);
    const r = syn.addRow([`${m.slice(5)}/${m.slice(0, 4)}`, x.volume, x.emises, x.signees, x.ratio, x.caPotentiel, x.caSigne]);
    r.getCell(5).numFmt = '0 %';
    r.getCell(6).numFmt = r.getCell(7).numFmt = '#,##0 €';
  }

  const rel = classeur.addWorksheet('Relances', { views: [{ state: 'frozen', ySplit: 1 }] });
  rel.columns = [
    { header: 'Statut', key: 'statut', width: 18 },
    { header: 'Relancer', key: 'relance', width: 16 },
    { header: 'Client', key: 'client', width: 28 },
    { header: 'Téléphone', key: 'tel', width: 15 },
    { header: 'Email', key: 'email', width: 28 },
    { header: 'Adresse de la fosse', key: 'adresse', width: 36 },
    { header: 'Secteur', key: 'secteur', width: 22 },
    { header: 'm³', key: 'volume', width: 5 },
    { header: 'Mensualité TTC', key: 'mens', width: 14 },
    { header: 'Total 24 mois TTC', key: 'total', width: 16 },
    { header: 'Facture vidange', key: 'facture', width: 16 },
    { header: 'Vidange le', key: 'vidange', width: 12 },
    { header: 'Contrat Dolibarr', key: 'contrat', width: 16 },
    { header: 'Émis le', key: 'emis', width: 12 },
    { header: 'Signé le', key: 'signe', width: 12 },
    { header: 'À savoir', key: 'note', width: 44 },
    { header: 'Suivi commercial', key: 'suivi', width: 30 },
  ];
  entete(rel.getRow(1));
  const date = (d: string | null) => (d ? new Date(d) : null);
  const ordre: db.ContratPropose['statut'][] = ['emis', 'pret', 'a_completer', 'signe', 'abandonne'];
  const lignes = contrats
    .filter((x) => x.statut !== 'ecarte')
    .sort((a, b) => ordre.indexOf(a.statut) - ordre.indexOf(b.statut) || (a.emis_le ?? a.cree_le).localeCompare(b.emis_le ?? b.cree_le));
  for (const c of lignes) {
    const jours = c.emis_le ? Math.floor((maintenant.getTime() - new Date(c.emis_le).getTime()) / 86_400_000) : 0;
    rel.addRow({
      statut: STATUTS[c.statut],
      relance: c.statut !== 'emis' ? '' : jours >= 30 ? 'dernière relance' : jours >= 7 ? 'à relancer' : `dans ${7 - jours} j`,
      client: c.client_nom, tel: c.telephone, email: c.email,
      adresse: [c.adresse, [c.cp, c.ville].filter(Boolean).join(' ')].filter(Boolean).join(', '),
      secteur: c.secteur ?? '', volume: c.volume,
      mens: c.mensualite === null ? null : Number(c.mensualite), total: c.mensualite === null ? null : totalDe(c),
      facture: c.facture_ref, vidange: date(c.facture_le), contrat: c.dolibarr_contrat_ref ?? '', emis: date(c.emis_le), signe: date(c.signe_le),
      note: c.note, suivi: '',
    });
  }
  for (const k of ['mens', 'total']) rel.getColumn(k).numFmt = '#,##0.00 €';
  for (const k of ['vidange', 'emis', 'signe']) rel.getColumn(k).numFmt = 'dd/mm/yyyy';
  rel.autoFilter = { from: 'A1', to: 'Q1' };
  return Buffer.from(await classeur.xlsx.writeBuffer());
}

/** Mail au bureau : le fichier de relances, et le contrat et le mandat de chaque nouvelle proposition. */
async function envoyerAuBureau(config: Config, contrats: db.ContratPropose[], documents: Documents[], signes: number, reel: boolean): Promise<void> {
  const xlsx = await fichierRelances(contrats);
  const jour = new Date().toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris' });
  const s = synthese(contrats);
  const n = documents.length;
  const corps = [
    'Bonjour,',
    n
      ? `${n} nouvelle${n > 1 ? 's' : ''} proposition${n > 1 ? 's' : ''} de contrat d'entretien après une vidange de fosse. ${n > 1 ? 'Elles sont' : 'Elle est'} en brouillon dans Dolibarr (contrats Sud Assainissement), avec le contrat et le mandat SEPA pré-remplis. Vous les trouverez aussi en pièces jointes, prêts à transmettre au client.`
      : 'Voici le point de la semaine sur les contrats d’entretien proposés après une vidange.',
    n > DOCS_PAR_MAIL ? `Ce mail joint les ${DOCS_PAR_MAIL} premiers contrats et mandats ; les autres sont sur leur contrat dans Dolibarr.` : '',
    signes ? `Bonne nouvelle : ${signes} contrat${signes > 1 ? 's' : ''} signé${signes > 1 ? 's' : ''} depuis le dernier point.` : '',
    `Où on en est : ${s.aFaire} à faire, ${s.emises} émises, ${s.signees} signées (${Math.round(s.ratio * 100)} % de conversion). CA potentiel ${euros(s.caPotentiel)} TTC, CA signé ${euros(s.caSigne)} TTC, ${s.volume} propositions pour ${s.volumeM3} m³ de fosses.`,
    'Le détail client par client, avec les relances à faire, est dans le fichier Relances contrats. Quand un contrat est validé dans Dolibarr, il passe en « signé » le lendemain.',
  ].filter(Boolean);
  const boite = config.boites.find((b) => b.id === config.rappels.boite) ?? config.boites[0];
  await envoyer({
    boite,
    nomExpediteur: 'Groupe CYRNEO',
    a: reel ? (config.contrats?.destinataires ?? DESTINATAIRES) : [config.test.adresse],
    sujet: `${reel ? '' : '[TEST] '}Relances contrats d'entretien${n ? ` : ${n} nouvelle${n > 1 ? 's' : ''} proposition${n > 1 ? 's' : ''}` : ''} — ${jour}`,
    texte: [...corps.flatMap((l) => [l, '']), 'Le secrétariat', SIGNATURE_TEXTE].join('\n'),
    html: mailHtml(corps, 'Le secrétariat'),
    images: imagesSignature(path.resolve('assets/signature')),
    piecesJointes: [
      { nom: `Relances contrats ${jour.replace(/\//g, '-')}.xlsx`, type: XLSX, taille: xlsx.length, contenu: xlsx },
      ...documents.slice(0, DOCS_PAR_MAIL).flatMap((d) => [d.contrat, d.mandat]),
    ],
    automatique: false,
  });
}
