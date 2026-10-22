import { afterEach, describe, expect, it, vi } from 'vitest';
import exemple from '../../config.exemple.json';
import { validerConfig } from '../logique/config';
import type { Classification } from '../logique/types';
import { creerBonIntervention, descriptionBon, entiteDe, trouverOuCreerClient } from './dolibarr';

const config = validerConfig({ ...exemple, dolibarr: { actif: true, url: 'https://doli.exemple.fr/', entites: { 'sud-assainissement': 2 } } });
const c: Classification = {
  categorie: 'demande_intervention', societe: 'sud-assainissement', urgence: 'urgente', resume: 'Fosse qui déborde', nature: 'vidange fosse',
  dateSouhaitee: 'demain', contact: { nom: "Jean O'Brien", telephone: '06 12 34 56 78', email: 'jean@orange.fr', adresse: '12 route de la mer', commune: 'Porticcio' },
};

type Appel = { url: string; init: RequestInit };
function simuler(reponses: Array<{ statut: number; corps: unknown }>) {
  const appels: Appel[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    appels.push({ url, init });
    const r = reponses.shift()!;
    return new Response(JSON.stringify(r.corps), { status: r.statut });
  }));
  return appels;
}

afterEach(() => vi.unstubAllGlobals());
process.env.DOLIBARR_API_KEY = 'cle-test';

describe('connecteur Dolibarr', () => {
  it("envoie la clé et l'entité de la société à chaque appel", async () => {
    const appels = simuler([{ statut: 200, corps: [{ id: '42', name: 'Jean' }] }]);
    const client = await trouverOuCreerClient(config, entiteDe(config, 'sud-assainissement'), c);
    expect(client).toEqual({ id: 42, nom: 'Jean', cree: false });
    const h = appels[0].init.headers as Record<string, string>;
    expect(h.DOLAPIKEY).toBe('cle-test');
    expect(h.DOLAPIENTITY).toBe('2');
    expect(appels[0].url).toMatch(/^https:\/\/doli\.exemple\.fr\/api\/index\.php\/thirdparties\?/);
    expect(decodeURIComponent(appels[0].url)).toContain("(t.email:=:'jean@orange.fr')");
  });

  it('cherche par téléphone puis crée le client si personne ne correspond', async () => {
    const appels = simuler([
      { statut: 404, corps: { error: { message: 'No thirdparty found' } } },
      { statut: 404, corps: { error: { message: 'No thirdparty found' } } },
      { statut: 200, corps: 77 },
    ]);
    const client = await trouverOuCreerClient(config, 2, c);
    expect(client).toEqual({ id: 77, nom: "Jean O'Brien", cree: true });
    expect(decodeURIComponent(appels[1].url)).toContain("(t.phone:like:'%612345678%')");
    const corps = JSON.parse(String(appels[2].init.body));
    expect(corps).toMatchObject({ name: "Jean O'Brien", client: 1, code_client: 'auto', phone: '0612345678', town: 'Porticcio' });
  });

  it('crée le bon en brouillon et renvoie sa référence', async () => {
    const appels = simuler([{ statut: 200, corps: 15 }, { statut: 200, corps: { id: '15', ref: 'FI2610-0015' } }]);
    const bon = await creerBonIntervention(config, 2, 42, c, 'INT-2026-0042');
    expect(bon).toEqual({ id: 15, ref: 'FI2610-0015' });
    const corps = JSON.parse(String(appels[0].init.body));
    expect(corps).toMatchObject({ socid: 42, fk_project: 0, ref_client: 'INT-2026-0042' });
    expect(corps.description).toContain('URGENT');
  });

  it('remonte le message d’erreur de Dolibarr', async () => {
    simuler([{ statut: 403, corps: { error: { code: 403, message: 'Insufficiant rights' } } }]);
    await expect(creerBonIntervention(config, 2, 42, c, 'X')).rejects.toThrow(/HTTP 403 Insufficiant rights/);
  });

  it('refuse une société sans entité', () => {
    expect(() => entiteDe(config, 'sottec')).toThrow(/Aucune entité/);
  });

  it('décrit le bon pour le technicien', () => {
    expect(descriptionBon(c, 'INT-1')).toBe(
      "vidange fosse\nURGENT\nLieu : 12 route de la mer, Porticcio\nContact : Jean O'Brien 06 12 34 56 78\nSouhaité : demain\nDemande : Fosse qui déborde\nRéf. secrétariat : INT-1"
    );
  });
});
