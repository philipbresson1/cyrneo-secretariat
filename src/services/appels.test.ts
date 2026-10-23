import { beforeEach, describe, expect, it, vi } from 'vitest';
import exemple from '../../config.exemple.json';
import { validerConfig } from '../logique/config';
import { indexer } from '../logique/tiers';

const db = vi.hoisted(() => ({
  lireSynchro: vi.fn(),
  ecrireSynchro: vi.fn(),
  interventionDuBon: vi.fn(async () => null),
  interventionRecenteSemblable: vi.fn(async () => null),
  creerInterventionTelephone: vi.fn(async (d: Record<string, unknown>) => ({ id: 1, reference: 'INT-2026-0100', ...d })),
  interventionsAvecBon: vi.fn(async () => []),
  majIntervention: vi.fn(),
  interventionParCle: vi.fn(async () => null),
  devisAvecProposition: vi.fn(async () => [] as unknown[]),
  devisOuvertsSansProposition: vi.fn(async () => [] as unknown[]),
  remplacerDevisSignes: vi.fn(),
  devisEnCoursDuTiers: vi.fn(async () => null),
}));
const bons = vi.hoisted(() => ({ liste: [] as unknown[], propositions: [] as { id: number; ref: string; socid: number; statut: number; creeLe: Date; signeLe: Date | null; libelle: string; refClient: string }[] }));
const publier = vi.hoisted(() => vi.fn());
vi.mock('./stockage', () => db);
vi.mock('./rainbow', async () => ({ ...(await vi.importActual<object>('./rainbow')), publier }));
vi.mock('./dolibarr', async () => ({
  ...(await vi.importActual<object>('./dolibarr')),
  lireBonsRecents: vi.fn(async () => bons.liste),
  lirePropositions: vi.fn(async (_c: unknown, _e: number, brouillons: boolean) => (brouillons ? bons.propositions.filter((p) => p.statut === 0) : bons.propositions)),
  bonParRef: vi.fn(async (_c: unknown, entite: number, ref: string) => (entite === 2 ? { id: 99, ref, socid: 5 } : null)),
}));
const classer = vi.hoisted(() => vi.fn());
vi.mock('./classifieur', () => ({ classer }));
const index = vi.hoisted(() => ({ courant: null as unknown }));
vi.mock('./tiers', async () => ({
  ...(await vi.importActual<object>('./tiers')),
  reconnaitreTiers: vi.fn(async () => {
    const i = index.courant as ReturnType<typeof indexer>;
    return { tiers: i.tiers.get(5), syndic: null, possibles: [], index: i };
  }),
  indexTiers: vi.fn(async () => index.courant),
}));
beforeEach(() => {
  index.courant = indexer([{ id: 5, nom: 'Résidence Les Pins', alias: '', code_client: 'CU5', code_fournisseur: '', siret: '', tva_intra: '', adresse: 'Route des Sanguinaires', cp: '20000', ville: 'Ajaccio', telephone: '04 95 00 00 00', email: '', parent_id: null, client: 1, fournisseur: 0, actif: true, note_publique: '', note_privee: '' }], []);
});

import { numeroBon, releverBonsDolibarr, releverDevisDolibarr, societeDeLaBulle, traiterMessageBulle } from './appels';

const config = validerConfig({ ...exemple, mode: 'reel', dolibarr: { ...exemple.dolibarr, entites: { 'sud-assainissement': 2 } } });
const bon = (id: number, jours = 1, statut = 0) => ({ id, ref: `FI${id}`, socid: 5, description: 'Vidange fosse\nurgent', statut, creeLe: new Date(Date.now() - jours * 86_400_000), refClient: '' });

beforeEach(() => vi.clearAllMocks());

describe('aller-retour Dolibarr', () => {
  it('au premier passage, reprend les bons ouverts récents sans les annoncer', async () => {
    db.lireSynchro.mockResolvedValueOnce(null);
    bons.liste = [bon(12), bon(11, 30), bon(10, 1, 3)];
    await releverBonsDolibarr(config, () => {});
    expect(db.creerInterventionTelephone).toHaveBeenCalledTimes(1);
    expect(db.creerInterventionTelephone).toHaveBeenCalledWith(expect.objectContaining({ source: 'dolibarr', dolibarr_id: 12, client_nom: 'Résidence Les Pins', urgence: 'urgente', nature: 'Vidange fosse' }));
    expect(publier).not.toHaveBeenCalled();
    expect(db.ecrireSynchro).toHaveBeenCalledWith('dolibarr_bons_2', '12');
  });

  it('annonce un nouveau bon saisi dans Dolibarr dans la bulle de la société', async () => {
    db.lireSynchro.mockResolvedValueOnce('12');
    bons.liste = [bon(13), bon(12)];
    await releverBonsDolibarr(config, () => {});
    expect(db.creerInterventionTelephone).toHaveBeenCalledTimes(1);
    expect(publier.mock.calls[0][1]).toMatch(/Inter saisie dans Dolibarr[\s\S]*INT-2026-0100 · bon FI13[\s\S]*Résidence Les Pins/);
  });

  it("rattache le bon à la demande déjà notée dans une bulle plutôt que d'en créer une seconde", async () => {
    db.lireSynchro.mockResolvedValueOnce('12');
    db.interventionRecenteSemblable.mockResolvedValueOnce({ id: 7, reference: 'INT-2026-0090' } as never);
    bons.liste = [bon(13)];
    await releverBonsDolibarr(config, () => {});
    expect(db.creerInterventionTelephone).not.toHaveBeenCalled();
    expect(db.majIntervention).toHaveBeenCalledWith(7, expect.objectContaining({ dolibarr_id: 13, dolibarr_ref: 'FI13' }));
  });

  it('écoute les bulles des sociétés et la bulle de test', () => {
    expect(societeDeLaBulle(config, 'Urgence assainissement')).toMatchObject({ id: 'sud-assainissement' });
    expect(societeDeLaBulle(config, 'Entretien vehicules cyrneo')).toBeNull();
    expect(societeDeLaBulle({ ...config, mode: 'test' }, 'Test secrétariat')).toBe('test');
    expect(societeDeLaBulle({ ...config, mode: 'test' }, 'SUD Travaux')).toMatchObject({ id: 'sud-travaux' });
  });

  it('mode test : un devis noté dans la bulle Sud Travaux est enregistré, sans réponse dans la bulle', async () => {
    classer.mockResolvedValueOnce({
      categorie: 'demande_devis', societe: 'sud-travaux', urgence: 'normale', resume: 'Devis mur', nature: 'devis mur de soutènement', dateSouhaitee: '', inspectionCamera: false,
      contact: { nom: 'M. Santucci', telephone: '06 10 20 30 40', email: '', adresse: '', commune: 'Cauro' },
    });
    const ancien = new Date('2026-09-15T09:00:00Z');
    const cree = await traiterMessageBulle({ ...config, mode: 'test' }, { id: 'p1', bulle: 'SUD Travaux', auteur: 'Jo', texte: 'Devis à faire mur de soutènement M. Santucci Cauro 06 10 20 30 40', date: ancien }, () => {});
    expect(cree).toBe(true);
    expect(db.creerInterventionTelephone).toHaveBeenCalledWith(expect.objectContaining({ type: 'devis', societe: 'sud-travaux', cree_le: ancien.toISOString() }));
    expect(publier).not.toHaveBeenCalled();
  });

  it('reprise des anciens posts : les anciennes demandes d’intervention sont ignorées', async () => {
    classer.mockResolvedValueOnce({
      categorie: 'demande_intervention', societe: 'sud-travaux', urgence: 'normale', resume: 'x', nature: 'x', dateSouhaitee: '', inspectionCamera: false,
      contact: { nom: 'X', telephone: '', email: '', adresse: '', commune: '' },
    });
    const cree = await traiterMessageBulle(config, { id: 'p2', bulle: 'SUD Travaux', auteur: 'Jo', texte: 'Reprise dalle garage chez M. X demain matin' }, () => {}, { reprise: true });
    expect(cree).toBe(false);
    expect(db.creerInterventionTelephone).not.toHaveBeenCalled();
  });

  it("attend 30 minutes avant de relever un bon, le temps que son n° soit ajouté au post", async () => {
    db.lireSynchro.mockResolvedValueOnce('12');
    bons.liste = [bon(14, 0), bon(13)];
    await releverBonsDolibarr(config, () => {});
    expect(db.creerInterventionTelephone).toHaveBeenCalledTimes(1);
    expect(db.ecrireSynchro).toHaveBeenCalledWith('dolibarr_bons_2', '13');
  });

  it('lit un n° de BI dans un post', () => {
    expect(numeroBon('Mme Leca fosse pleine Cauro — BI FI2610-0012')).toBe('FI2610-0012');
    expect(numeroBon('bi 2610-012 fait')).toBe('FI2610-012');
    expect(numeroBon('rappeler au 06 12 34 56 78')).toBeNull();
  });

  it('post modifié avec le n° du BI : la fiche du post est liée au bon, sans nouvelle lecture', async () => {
    db.interventionParCle.mockResolvedValueOnce({ id: 8, reference: 'INT-2026-0101', societe: 'sud-assainissement', dolibarr_ref: null } as never);
    process.env.DOLIBARR_API_KEY = 'cle';
    await traiterMessageBulle(config, { id: 'm2', remplace: 'm1', bulle: 'Intervention SUD ASSAINISSEMENT', auteur: 'Alison', texte: 'Mme Leca fosse pleine Cauro 06 11 22 33 44 — FI2610-0012' }, () => {});
    expect(db.interventionParCle).toHaveBeenCalledWith('rainbow:m1');
    expect(db.majIntervention).toHaveBeenCalledWith(8, expect.objectContaining({ dolibarr_ref: 'FI2610-0012', dolibarr_id: 99, dolibarr_entite: 2 }));
    expect(classer).not.toHaveBeenCalled();
  });

  it('nouveau post-it : fiche créée, tiers donné en réponse, aucun bon créé', async () => {
    classer.mockResolvedValueOnce({
      categorie: 'demande_intervention', societe: 'sud-assainissement', urgence: 'normale', resume: 'Fosse pleine', nature: 'vidange fosse', dateSouhaitee: '', inspectionCamera: false,
      contact: { nom: 'Résidence Les Pins', telephone: '04 95 00 00 00', email: '', adresse: 'Route des Sanguinaires', commune: 'Ajaccio' },
    });
    await traiterMessageBulle(config, { id: 'm3', bulle: 'Intervention SUD ASSAINISSEMENT', auteur: 'Alison', texte: 'Résidence Les Pins, route des Sanguinaires, vidange fosse 04 95 00 00 00' }, () => {});
    expect(db.creerInterventionTelephone).toHaveBeenCalledWith(expect.objectContaining({ source: 'rainbow', cle: 'rainbow:m3', dolibarr_tiers_id: 5 }));
    expect(publier.mock.calls[0][0]).toBe('Intervention SUD ASSAINISSEMENT');
    expect(publier.mock.calls[0][1]).toMatch(/✅ INT-2026-0100 · Sud Assainissement[\s\S]*Résidence Les Pins/);
  });

  it('devis noté dans Rainbow : relié à la proposition Dolibarr du même client, qui le sort des devis à faire', async () => {
    bons.propositions = [
      { id: 40, ref: 'PR2610-0040', socid: 5, statut: 1, creeLe: new Date(), signeLe: null, libelle: 'Mur', refClient: '' },
      { id: 41, ref: 'PR2610-0041', socid: 6, statut: 2, creeLe: new Date(), signeLe: new Date('2026-10-20T10:00:00Z'), libelle: 'Regard', refClient: '' },
    ];
    db.devisOuvertsSansProposition.mockResolvedValueOnce([{ id: 12, reference: 'DEV-2026-0012', client_nom: 'les pins résidence', dolibarr_tiers_id: null, statut: 'a_planifier' }] as never);
    await releverDevisDolibarr({ ...config, dolibarr: { ...config.dolibarr, entites: { 'sud-travaux': 3 } } }, () => {});
    expect(db.creerInterventionTelephone).not.toHaveBeenCalled(); // Dolibarr ne crée jamais de devis à faire
    expect(db.majIntervention).toHaveBeenCalledWith(12, expect.objectContaining({ dolibarr_id: 40, dolibarr_ref: 'PR2610-0040', statut: 'planifiee' }));
    expect(db.remplacerDevisSignes).toHaveBeenCalledWith(3, [
      { id: 41, ref: 'PR2610-0041', societe: 'sud-travaux', tiers_id: 6, tiers_nom: '', libelle: 'Regard', signe_le: '2026-10-20T10:00:00.000Z' },
    ]);
  });

  it('proposition déjà reliée : la demande suit son statut (signée → acceptée)', async () => {
    bons.propositions = [{ id: 41, ref: 'PR2610-0041', socid: 5, statut: 2, creeLe: new Date(), signeLe: null, libelle: '', refClient: '' }];
    db.devisAvecProposition.mockResolvedValueOnce([{ id: 9, dolibarr_id: 41, statut: 'planifiee' }]);
    await releverDevisDolibarr({ ...config, dolibarr: { ...config.dolibarr, entites: { 'sud-travaux': 3 } } }, () => {});
    expect(db.majIntervention).toHaveBeenCalledWith(9, { statut: 'realisee' });
  });

});
