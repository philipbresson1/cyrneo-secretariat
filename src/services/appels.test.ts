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
}));
const bons = vi.hoisted(() => ({ liste: [] as unknown[] }));
const publier = vi.hoisted(() => vi.fn());
vi.mock('./stockage', () => db);
vi.mock('./rainbow', async () => ({ ...(await vi.importActual<object>('./rainbow')), publier }));
vi.mock('./dolibarr', async () => ({ ...(await vi.importActual<object>('./dolibarr')), lireBonsRecents: vi.fn(async () => bons.liste) }));
vi.mock('./tiers', async () => ({
  ...(await vi.importActual<object>('./tiers')),
  indexTiers: vi.fn(async () =>
    indexer([{ id: 5, nom: 'Résidence Les Pins', alias: '', code_client: 'CU5', adresse: 'Route des Sanguinaires', cp: '20000', ville: 'Ajaccio', telephone: '04 95 00 00 00', email: '', parent_id: null, client: 1, fournisseur: 0, actif: true, note_publique: '', note_privee: '' }], [])
  ),
}));

import { releverBonsDolibarr, societeDeLaBulle } from './appels';

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

  it('écoute les bulles des sociétés (et seulement la bulle de test en mode test)', () => {
    expect(societeDeLaBulle(config, 'Urgence assainissement')).toMatchObject({ id: 'sud-assainissement' });
    expect(societeDeLaBulle(config, 'Entretien vehicules cyrneo')).toBeNull();
    expect(societeDeLaBulle({ ...config, mode: 'test' }, 'Test secrétariat')).toBe('test');
    expect(societeDeLaBulle({ ...config, mode: 'test' }, 'SUD Travaux')).toBeNull();
  });
});
