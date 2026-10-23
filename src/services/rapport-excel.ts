/**
 * Tableau Excel quotidien : interventions et devis demandés, factures reçues, journal
 * complet du jour, et suivi de tout ce qui reste ouvert.
 */
import ExcelJS from 'exceljs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Config, Intervention } from '../logique/types';
import { LIBELLES_CATEGORIES, type Categorie } from '../logique/types';
import { interventionsEntre, interventionsOuvertes, journalEntre, type JournalLu } from './stockage';
import { decalageParis } from '../lib/agenda';

const STATUTS: Record<string, string> = {
  coordonnees_demandees: 'Coordonnées demandées',
  a_planifier: 'À planifier',
  planifiee: 'Planifiée',
  realisee: 'Réalisée',
  annulee: 'Annulée',
};

export function bornesJourParis(jour: string): { debut: Date; fin: Date } {
  const decalage = decalageParis(new Date(`${jour}T12:00:00Z`));
  const debut = new Date(`${jour}T00:00:00${decalage}`);
  return { debut, fin: new Date(debut.getTime() + 86_400_000) };
}

/** Excel n'a pas de fuseau : on lui donne l'heure de Paris « telle qu'affichée ». */
export function pourExcel(iso: string | null): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  const [signe, h, m] = decalageParis(d).match(/([+-])(\d{2}):(\d{2})/)!.slice(1);
  const minutes = (Number(h) * 60 + Number(m)) * (signe === '-' ? -1 : 1);
  return new Date(d.getTime() + minutes * 60_000);
}

function nomSociete(config: Config, id: string | null): string {
  return config.societes.find((s) => s.id === id)?.nom ?? id ?? '';
}

function feuille(classeur: ExcelJS.Workbook, nom: string, colonnes: { header: string; key: string; width: number }[]) {
  const f = classeur.addWorksheet(nom, { views: [{ state: 'frozen', ySplit: 1 }] });
  f.columns = colonnes;
  f.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  f.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3A5F' } };
  f.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: colonnes.length } };
  return f;
}

const COLONNES_INTER = [
  { header: 'Référence', key: 'reference', width: 15 },
  { header: 'Reçue le', key: 'cree_le', width: 17 },
  { header: 'Société', key: 'societe', width: 22 },
  { header: 'Statut', key: 'statut', width: 22 },
  { header: 'Urgence', key: 'urgence', width: 10 },
  { header: 'Client', key: 'client_nom', width: 24 },
  { header: 'Téléphone', key: 'client_telephone', width: 16 },
  { header: 'Email', key: 'client_email', width: 28 },
  { header: 'Adresse', key: 'adresse', width: 30 },
  { header: 'Commune', key: 'commune', width: 16 },
  { header: 'Demande', key: 'nature', width: 30 },
  { header: 'Souhaité', key: 'date_souhaitee', width: 16 },
  { header: 'Prévue le', key: 'date_prevue', width: 17 },
  { header: 'Intervenant', key: 'intervenant', width: 16 },
  { header: 'Résumé', key: 'resume', width: 50 },
  { header: 'Bon Dolibarr', key: 'dolibarr_ref', width: 16 },
];

function ligneInter(config: Config, i: Intervention) {
  return {
    ...i,
    cree_le: pourExcel(i.cree_le),
    date_prevue: pourExcel(i.date_prevue),
    societe: nomSociete(config, i.societe),
    statut: STATUTS[i.statut] ?? i.statut,
    urgence: i.urgence === 'urgente' ? 'URGENT' : '',
  };
}

function ligneJournal(config: Config, j: JournalLu) {
  return {
    recu_le: pourExcel(j.recu_le),
    boite: j.boite,
    expediteur: j.expediteur,
    sujet: j.sujet,
    categorie: j.categorie ? LIBELLES_CATEGORIES[j.categorie as Categorie] ?? j.categorie : '',
    societe: nomSociete(config, j.societe),
    resume: j.resume ?? '',
    statut: j.statut,
    actions: j.actions.map((a) => `${a.ok ? '' : '✗ '}${a.action} : ${a.detail}`).join('\n'),
    fichiers: j.fichiers.join('\n'),
    erreur: j.erreur ?? '',
  };
}

const COLONNES_JOURNAL = [
  { header: 'Reçu le', key: 'recu_le', width: 17 },
  { header: 'Boîte', key: 'boite', width: 18 },
  { header: 'Expéditeur', key: 'expediteur', width: 32 },
  { header: 'Sujet', key: 'sujet', width: 40 },
  { header: 'Catégorie', key: 'categorie', width: 22 },
  { header: 'Société', key: 'societe', width: 20 },
  { header: 'Résumé', key: 'resume', width: 50 },
  { header: 'Statut', key: 'statut', width: 12 },
  { header: 'Actions', key: 'actions', width: 60 },
  { header: 'Fichiers', key: 'fichiers', width: 50 },
  { header: 'Erreur', key: 'erreur', width: 40 },
];

/** Écrit le classeur du jour (AAAA-MM-JJ, heure de Paris) et renvoie son chemin. */
export async function genererRapport(config: Config, jour: string): Promise<string> {
  const { debut, fin } = bornesJourParis(jour);
  const [inters, journal, ouvertes] = await Promise.all([interventionsEntre(debut, fin), journalEntre(debut, fin), interventionsOuvertes()]);

  const classeur = new ExcelJS.Workbook();
  classeur.creator = 'Secrétariat CYRNEO';

  const fi = feuille(classeur, 'Interventions demandées', COLONNES_INTER);
  inters.filter((i) => i.type === 'intervention').forEach((i) => fi.addRow(ligneInter(config, i)));

  const fd = feuille(classeur, 'Demandes de devis', COLONNES_INTER);
  inters.filter((i) => i.type === 'devis').forEach((i) => fd.addRow(ligneInter(config, i)));

  const fr = feuille(classeur, 'Réclamations', COLONNES_INTER);
  inters.filter((i) => i.type === 'reclamation').forEach((i) => fr.addRow(ligneInter(config, i)));

  const ff = feuille(classeur, 'Factures reçues', COLONNES_JOURNAL);
  journal.filter((j) => j.categorie === 'facture_recue').forEach((j) => ff.addRow(ligneJournal(config, j)));

  const fo = feuille(classeur, 'Suivi (tout ce qui est ouvert)', COLONNES_INTER);
  ouvertes.forEach((i) => fo.addRow(ligneInter(config, i)));

  const fj = feuille(classeur, 'Journal complet', COLONNES_JOURNAL);
  journal.forEach((j) => fj.addRow(ligneJournal(config, j)));

  for (const f of classeur.worksheets) {
    f.eachRow((r, n) => {
      if (n > 1) r.alignment = { vertical: 'top', wrapText: true };
    });
    f.columns.forEach((c) => {
      if (['cree_le', 'recu_le', 'date_prevue'].includes(String(c.key))) c.numFmt = 'dd/mm/yyyy hh:mm';
    });
  }

  await mkdir(path.resolve(config.dossiers.rapports), { recursive: true });
  const fichier = path.resolve(config.dossiers.rapports, `Secretariat-${jour}.xlsx`);
  await classeur.xlsx.writeFile(fichier);
  return fichier;
}
