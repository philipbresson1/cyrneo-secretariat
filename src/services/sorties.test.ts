import { afterAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import ExcelJS from 'exceljs';
import exemple from '../../config.exemple.json';
import { validerConfig } from '../logique/config';
import type { Intervention } from '../logique/types';

const inter: Intervention = {
  id: 1, reference: 'INT-2026-0001', type: 'intervention', societe: 'sud-assainissement', statut: 'a_planifier', urgence: 'urgente',
  client_nom: 'Jean <Martin>', client_telephone: '06 12 34 56 78', client_email: 'j@m.fr', adresse: '12 route de la mer', commune: 'Porticcio',
  nature: 'vidange fosse', date_souhaitee: 'demain', resume: 'Fosse qui déborde', boite: 'sud-assainissement', mail_message_id: '<a>',
  relance_message_id: null, date_prevue: null, intervenant: null, notes: null, dolibarr_ref: null, cree_le: '2026-10-22T07:00:00Z',
};
const journal = {
  id: 1, boite: 'sud-assainissement', recu_le: '2026-10-22T07:00:00Z', expediteur: 'Jean Martin <j@m.fr>', expediteur_adresse: 'j@m.fr',
  sujet: 'Fosse pleine', categorie: 'facture_recue', societe: 'sud-assainissement', urgence: 'normale', resume: 'Facture de pompe',
  actions: [{ action: 'classer_pieces_jointes', detail: '1 fichier', ok: true, simulee: false }], statut: 'traite', erreur: null,
  intervention_id: null, fichiers: ['C:/x/f.pdf'], traite_le: '2026-10-22T07:01:00Z',
};

vi.mock('./stockage', () => ({
  interventionsOuvertes: async () => [inter],
  interventionsEntre: async () => [inter],
  dernieresRealisees: async () => [{ ...inter, id: 2, statut: 'realisee', client_nom: 'Mme Leca', dolibarr_ref: 'FI2610-0007', maj_le: '2026-10-23T15:00:00Z' }],
  journalEntre: async () => [journal],
  chercherJournal: async () => [journal],
  majIntervention: vi.fn(async () => inter),
  creerInterventionManuelle: vi.fn(async () => inter),
}));

const config = validerConfig({ ...exemple, agendas: [], ecran: { colonnes: [] } });
let dossier = '';
afterAll(async () => dossier && rm(dossier, { recursive: true, force: true }));

describe('écran et pages locales', () => {
  it('affiche les interventions, échappe le HTML et protège les pages internes', async () => {
    process.env.SECRETARIAT_CLE = 'cle-test';
    const { demarrerServeur } = await import('./serveur');
    const serveur = demarrerServeur({ ...config, serveur: { port: 0, ecranPublic: true } }, { demarreLe: new Date(), dernierPassage: null, erreurs: [], mode: 'simulation' });
    await new Promise((r) => serveur.once('listening', r));
    const base = `http://127.0.0.1:${(serveur.address() as AddressInfo).port}`;

    const ecran = await (await fetch(`${base}/ecran`)).text();
    expect(ecran).toContain('Bons à traiter');
    expect(ecran).toContain('vidange fosse');
    expect(ecran).toContain('Jean &lt;Martin&gt;');
    expect((await fetch(`${base}/journal`)).status).toBe(401);
    const j = await fetch(`${base}/journal?cle=cle-test`);
    expect(j.status).toBe(200);
    expect(await j.text()).toContain('Facture reçue');
    expect((await fetch(`${base}/interventions?cle=cle-test`)).status).toBe(200);
    const equipes = await (await fetch(`${base}/equipes?zoom=1.4`)).text();
    expect(equipes).toContain('Planning équipes');
    expect(equipes).toContain('calc(clamp(15px,1.3vw,36px) * 1.4)');
    expect(equipes).toContain('En attente de réalisation');
    expect(equipes).toContain('Jean &lt;Martin&gt;');
    const bureau = await (await fetch(`${base}/bureau`)).text();
    expect(bureau).toContain("Cahier d'appels");
    expect(bureau).toContain('À faire');
    expect(bureau).toContain('BI finalisés');
    expect(bureau).toContain('1</b><span>urgence(s) à caler');
    expect(bureau).toContain('href="/bureau?vue=urgentes"');
    for (const lien of ['/equipes', '/bureau', '/interventions', '/journal']) expect(bureau).toContain(`href="${lien}"`);
    const urgentes = await (await fetch(`${base}/bureau?vue=urgentes&zoom=1.2`)).text();
    expect(urgentes).toContain('Retour au cahier');
    expect(urgentes).toContain('href="/bureau?zoom=1.2"');
    expect(urgentes).toContain('Jean &lt;Martin&gt;');
    expect(bureau).toContain('Jean &lt;Martin&gt;');
    expect(bureau).toContain('à prévoir');
    const nouvelle = await fetch(`${base}/interventions/nouvelle?cle=cle-test`, {
      method: 'POST',
      body: 'societe=sud-assainissement&type=intervention&urgence=urgente&client_nom=Mme+Santoni&client_telephone=0611223344&nature=Vidange+fosse',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      redirect: 'manual',
    });
    expect(nouvelle.status).toBe(303);
    const { creerInterventionManuelle } = await import('./stockage');
    expect(creerInterventionManuelle).toHaveBeenCalledWith(expect.objectContaining({ client_nom: 'Mme Santoni', urgence: 'urgente', societe: 'sud-assainissement' }));
    const post = await fetch(`${base}/interventions/1?cle=cle-test`, { method: 'POST', body: 'statut=planifiee&date_prevue=2026-10-23T09:00&intervenant=Paul', headers: { 'content-type': 'application/x-www-form-urlencoded' }, redirect: 'manual' });
    expect(post.status).toBe(303);
    serveur.close();
  });
});

describe('titres d’agenda', () => {
  it('met un rendez-vous sur une ligne et retire les mentions Rainbow', async () => {
    const { nettoyerTitre } = await import('./serveur');
    expect(nettoyerTitre('Débouchage regard\nERRARD Christophe\n\nPorticcio <@Joseph Rossi:667c>  tu peux')).toBe('Débouchage regard · ERRARD Christophe · Porticcio tu peux');
  });
});

describe('rapport Excel', () => {
  it('écrit les six feuilles avec les bonnes lignes', async () => {
    dossier = await mkdtemp(path.join(os.tmpdir(), 'rapport-'));
    const { genererRapport } = await import('./rapport-excel');
    const fichier = await genererRapport({ ...config, dossiers: { factures: dossier, rapports: dossier, vehicules: dossier } }, '2026-10-22');
    const c = new ExcelJS.Workbook();
    await c.xlsx.readFile(fichier);
    expect(c.worksheets.map((f) => f.name)).toEqual(['Interventions demandées', 'Demandes de devis', 'Réclamations', 'Factures reçues', 'Suivi (tout ce qui est ouvert)', 'Journal complet']);
    expect(c.getWorksheet('Interventions demandées')!.getRow(2).getCell(1).value).toBe('INT-2026-0001');
    expect(c.getWorksheet('Factures reçues')!.rowCount).toBe(2);
    // 07:00 UTC = 09:00 à Paris en octobre (heure d'été)
    expect((c.getWorksheet('Interventions demandées')!.getRow(2).getCell(2).value as Date).getUTCHours()).toBe(9);
  });
});
