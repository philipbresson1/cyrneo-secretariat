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
  majDevisSignes: vi.fn(),
  enregistrerBons: vi.fn(),
  statutsDesBons: vi.fn(async () => new Map<string, number>()),
  fichesDeBonsOuvertes: vi.fn(async () => [] as unknown[]),
  devisEnCoursSemblable: vi.fn(async () => null),
  devisEnCoursDuTiers: vi.fn(async () => null),
}));
const bons = vi.hoisted(() => ({ liste: [] as unknown[], modifies: [] as unknown[], synchro: {} as Record<string, string>, propositions: [] as { id: number; ref: string; socid: number; statut: number; creeLe: Date; signeLe: Date | null; libelle: string; refClient: string }[] }));
const publier = vi.hoisted(() => vi.fn());
vi.mock('./stockage', () => db);
vi.mock('./rainbow', async () => ({ ...(await vi.importActual<object>('./rainbow')), publier }));
vi.mock('./dolibarr', async () => ({
  ...(await vi.importActual<object>('./dolibarr')),
  // Filtres côté Dolibarr : nouveaux depuis un n°, créés depuis une date, ou modifiés.
  lireBons: vi.fn(async (_c: unknown, _e: number, filtre: string) => {
    const liste = bons.liste as { id: number; creeLe: Date }[];
    const n = /t\.rowid:>:(\d+)/.exec(filtre);
    if (n) return liste.filter((b) => b.id > Number(n[1]));
    if (filtre.includes('t.datec')) return liste.filter((b) => Date.now() - b.creeLe.getTime() < 14 * 86_400_000);
    return bons.modifies;
  }),
  lirePropositions: vi.fn(async () => bons.propositions),
  bonParRef: vi.fn(async (_c: unknown, entite: number, ref: string) => (entite === 2 ? { id: 99, ref, socid: 5 } : null)),
  creerClient: vi.fn(async () => 777),
  creerBonIntervention: vi.fn(async () => ({ id: 700, ref: 'I-SA-260700' })),
}));
const inscrire = vi.hoisted(() => vi.fn(async () => 'https://calendar.google.com/x'));
vi.mock('./google-agenda', () => ({ inscrire, agendaGoogleConfigure: () => true }));
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
  ajouterTiersLocal: vi.fn(),
  tiersParId: vi.fn(async (_c: unknown, _e: number, id: number) => (index.courant as ReturnType<typeof indexer>).tiers.get(id) ?? null),
}));
beforeEach(() => {
  index.courant = indexer([{ id: 5, nom: 'Résidence Les Pins', alias: '', code_client: 'CU5', code_fournisseur: '', siret: '', tva_intra: '', adresse: 'Route des Sanguinaires', cp: '20000', ville: 'Ajaccio', telephone: '04 95 00 00 00', email: '', parent_id: null, client: 1, fournisseur: 0, actif: true, note_publique: '', note_privee: '' }], []);
});

import { enregistrerDansLesOutils, numeroBon, numeroDevis, releverBonsDolibarr, releverDevisDolibarr, societeDeLaBulle, traiterMessageBulle } from './appels';

const config = validerConfig({ ...exemple, mode: 'reel', dolibarr: { ...exemple.dolibarr, entites: { 'sud-assainissement': 2 } } });
const bon = (id: number, jours = 1, statut = 0) => ({ id, ref: `FI${id}`, socid: 5, description: 'Vidange fosse\nurgent', statut, creeLe: new Date(Date.now() - jours * 86_400_000), refClient: '' });

beforeEach(() => {
  vi.clearAllMocks();
  bons.synchro = {};
  bons.modifies = [];
  db.lireSynchro.mockImplementation(async (nom: string) => bons.synchro[nom] ?? null);
  bons.synchro.dolibarr_bons_copie = new Date().toISOString(); // copie complète déjà faite
});

describe('aller-retour Dolibarr', () => {
  it('au premier passage, reprend les bons ouverts récents sans les annoncer', async () => {
    bons.liste = [bon(12), bon(11, 30), bon(10, 1, 3)];
    await releverBonsDolibarr(config, () => {});
    expect(db.creerInterventionTelephone).toHaveBeenCalledTimes(1);
    expect(db.creerInterventionTelephone).toHaveBeenCalledWith(expect.objectContaining({ source: 'dolibarr', dolibarr_id: 12, client_nom: 'Résidence Les Pins', urgence: 'urgente', nature: 'Vidange fosse' }));
    expect(publier).not.toHaveBeenCalled();
    expect(db.ecrireSynchro).toHaveBeenCalledWith('dolibarr_bons_2', '12');
  });

  it('annonce un nouveau bon saisi dans Dolibarr dans la bulle de la société', async () => {
    bons.synchro.dolibarr_bons_2 = '12';
    bons.liste = [bon(13), bon(12)];
    await releverBonsDolibarr(config, () => {});
    expect(db.creerInterventionTelephone).toHaveBeenCalledTimes(1);
    expect(publier.mock.calls[0][1]).toMatch(/Inter saisie dans Dolibarr[\s\S]*INT-2026-0100 · bon FI13[\s\S]*Résidence Les Pins/);
  });

  it("rattache le bon à la demande déjà notée dans une bulle plutôt que d'en créer une seconde", async () => {
    bons.synchro.dolibarr_bons_2 = '12';
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
    bons.synchro.dolibarr_bons_2 = '12';
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


  it('statut des fiches : bon validé → réalisée, d’après la copie des bons relue sur les seuls bons modifiés', async () => {
    bons.synchro.dolibarr_bons_2 = '20';
    bons.synchro.dolibarr_bons_controle = new Date(Date.now() - 3_600_000).toISOString();
    bons.liste = [];
    bons.modifies = [{ ...bon(15, 3, 1), facturationDemarree: false }];
    db.statutsDesBons.mockResolvedValueOnce(new Map([['2:15', 1]]));
    db.fichesDeBonsOuvertes.mockResolvedValueOnce([{ id: 4, reference: 'INT-2026-0004', statut: 'planifiee', dolibarr_entite: 2, dolibarr_id: 15, dolibarr_ref: 'I-SA-260015' }] as never);
    await releverBonsDolibarr(config, () => {});
    expect(db.enregistrerBons).toHaveBeenCalledWith([expect.objectContaining({ entite: 2, id: 15, statut: 1, facturation_demarree: false, tiers_nom: 'Résidence Les Pins' })]);
    expect(db.majIntervention).toHaveBeenCalledWith(4, { statut: 'realisee' });
    expect(db.ecrireSynchro).toHaveBeenCalledWith('dolibarr_bons_controle', expect.any(String));
  });

  it('BI en brouillon : la fiche est « planifiée », jamais « à planifier »', async () => {
    bons.synchro.dolibarr_bons_2 = '12';
    bons.liste = [bon(13)];
    await releverBonsDolibarr(config, () => {});
    expect(db.creerInterventionTelephone).toHaveBeenCalledWith(expect.objectContaining({ dolibarr_id: 13, statut: 'planifiee' }));
  });

  it('lit les n° du groupe dans un post (I-SA-…, D-ST-…)', () => {
    expect(numeroBon('Vidange Mme Leca — I-SA-260534')).toBe('I-SA-260534');
    expect(numeroDevis('devis fait : D-ST-260055')).toBe('D-ST-260055');
  });

  it('devis : relevé des seules propositions modifiées, la liste des signés est mise à jour sans tout remplacer', async () => {
    bons.synchro.dolibarr_devis = new Date(Date.now() - 900_000).toISOString();
    bons.propositions = [
      { id: 50, ref: 'PR50', socid: 5, statut: 2, creeLe: new Date(), signeLe: null, libelle: 'Mur', refClient: '' },
      { id: 51, ref: 'PR51', socid: 5, statut: 4, creeLe: new Date(), signeLe: null, libelle: 'Regard', refClient: '' },
    ];
    await releverDevisDolibarr(config, () => {});
    expect(db.remplacerDevisSignes).not.toHaveBeenCalled();
    expect(db.majDevisSignes).toHaveBeenCalledWith(2, [expect.objectContaining({ id: 50, ref: 'PR50' })], [51]);
    expect(db.ecrireSynchro).toHaveBeenCalledWith('dolibarr_devis', expect.any(String));
  });

  it('post du soir « à rappeler demain 8h » : client créé, BI en brouillon, rappel au planning Débouchage', async () => {
    process.env.DOLIBARR_API_KEY = 'cle';
    const reel = { ...config, dolibarr: { ...config.dolibarr, actif: true, url: 'https://doli.fr', entites: { 'sud-assainissement': 2 } } };
    const c = {
      categorie: 'demande_intervention' as const, societe: 'sud-assainissement', urgence: 'normale' as const, resume: 'WC bouchés', nature: 'débouchage WC', dateSouhaitee: 'demain',
      inspectionCamera: false, creneau: '2026-10-25T08:00', creneauType: 'rappel' as const,
      contact: { nom: 'Mme Rossi', telephone: '06 01 02 03 04', email: '', adresse: '3 rue Fesch', commune: 'Ajaccio' },
    };
    const fiche = { id: 42, reference: 'INT-2026-0200', client_nom: 'Mme Rossi', client_telephone: '06 01 02 03 04', adresse: '3 rue Fesch', commune: 'Ajaccio', nature: 'débouchage WC', dolibarr_ref: null } as never;
    db.majIntervention.mockImplementation(async (_id: number, champs: object) => ({ ...(fiche as object), ...champs }));
    const lignes = await enregistrerDansLesOutils(reel, reel.societes.find((x) => x.id === 'sud-assainissement')!, fiche, c, { tiers: null, syndic: null, possibles: [], index: index.courant } as never, false, 'Philip', () => {});
    expect(lignes).toEqual([
      '👤 Nouveau client créé dans Dolibarr : Mme Rossi',
      '🧾 BI I-SA-260700 créé (brouillon)',
      expect.stringMatching(/^📅 Rappel inscrit au planning Débouchage : dimanche 25 octobre (à )?08:00$/),
    ]);
    expect(inscrire).toHaveBeenCalledWith('debouchagesudassai@gmail.com', expect.objectContaining({ titre: '📞 À rappeler — Mme Rossi — débouchage WC', debut: '2026-10-25T08:00', minutes: 15 }));
    expect((inscrire.mock.calls[0] as unknown[])[1]).toMatchObject({ description: expect.stringContaining('INT-2026-0200 · I-SA-260700') });
    expect(db.majIntervention).toHaveBeenCalledWith(42, expect.objectContaining({ statut: 'planifiee', date_prevue: '2026-10-25T07:00:00.000Z' }));
  });

  it('en mode test : rien n’est écrit, la réponse dit ce qui serait fait', async () => {
    const c = { categorie: 'demande_intervention' as const, societe: 'sud-assainissement', urgence: 'normale' as const, resume: '', nature: 'débouchage', dateSouhaitee: '', inspectionCamera: false, creneau: '2026-10-25T08:00', creneauType: 'rappel' as const, contact: { nom: 'Mme Rossi', telephone: '', email: '', adresse: '', commune: '' } };
    const lignes = await enregistrerDansLesOutils({ ...config, mode: 'test' }, config.societes.find((x) => x.id === 'sud-assainissement')!, { id: 1, reference: 'INT-1' } as never, c, null, false, '', () => {});
    expect(lignes[0]).toBe('🧪 Client à créer dans Dolibarr : Mme Rossi');
    expect(lignes[1]).toMatch(/^🧪 Rappel qui serait inscrit au planning Débouchage/);
    expect(inscrire).not.toHaveBeenCalled();
  });
});
