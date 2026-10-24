import { afterEach, describe, expect, it, vi } from 'vitest';
import exemple from '../../config.exemple.json';
import { validerConfig } from '../logique/config';
import type { Classification } from '../logique/types';
import { creerBonIntervention, daterBon, descriptionBon, entiteDe, lireTiersEtContacts } from './dolibarr';

const config = validerConfig({ ...exemple, dolibarr: { actif: true, url: 'https://doli.exemple.fr/', entites: { 'sud-assainissement': 2 } } });
const c: Classification = {
  categorie: 'demande_intervention', societe: 'sud-assainissement', urgence: 'urgente', resume: 'Fosse qui déborde', nature: 'vidange fosse',
  dateSouhaitee: 'demain', inspectionCamera: false, contact: { nom: "Jean O'Brien", telephone: '06 12 34 56 78', email: 'jean@orange.fr', adresse: '12 route de la mer', commune: 'Porticcio' },
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
  it("lit tous les tiers et contacts, page par page, avec la clé et l'entité", async () => {
    const appels = simuler([
      { statut: 200, corps: [{ id: '42', name: 'Résidence Les Pins', address: 'Route des Sanguinaires', town: 'Ajaccio', parent: '7', status: '1', email: 'X@Y.FR', phone: null }] },
      { statut: 200, corps: [{ id: '9', socid: '42', firstname: 'Paul', lastname: 'Leca', email: 'paul@leca.fr', phone_mobile: '06 11 22 33 44' }] },
    ]);
    const { tiers, contacts } = await lireTiersEtContacts(config);
    expect(tiers[0]).toMatchObject({ id: 42, nom: 'Résidence Les Pins', parent_id: 7, actif: true, email: 'x@y.fr', telephone: '' });
    expect(tiers[0].brut).not.toHaveProperty('phone');
    expect(contacts[0]).toMatchObject({ id: 9, tiers_id: 42, nom: 'Paul Leca', telephone: '06 11 22 33 44' });
    const h = appels[0].init.headers as Record<string, string>;
    expect(h.DOLAPIKEY).toBe('cle-test');
    expect(h.DOLAPIENTITY).toBe('2');
    expect(appels[0].url).toBe('https://doli.exemple.fr/api/index.php/thirdparties?limit=500&page=0&sortfield=t.rowid&sortorder=ASC');
  });

  it('crée le bon en brouillon et renvoie sa référence', async () => {
    const appels = simuler([{ statut: 200, corps: 15 }, { statut: 200, corps: { id: '15', ref: 'FI2610-0015' } }]);
    const bon = await creerBonIntervention(config, 2, 42, c, 'INT-2026-0042');
    expect(bon).toEqual({ id: 15, ref: 'FI2610-0015' });
    const corps = JSON.parse(String(appels[0].init.body));
    expect(corps).toMatchObject({ socid: 42, fk_project: 0, ref_client: 'INT-2026-0042' });
    expect(corps.description).toContain('URGENT');
  });

  it('crée le bon daté : ligne datée pour le panier des agents', async () => {
    const date = new Date('2026-10-24T06:00:00Z');
    const appels = simuler([
      { statut: 200, corps: 16 },
      { statut: 200, corps: { id: '16', ref: 'I-SA-260700' } },
      { statut: 200, corps: { id: '16', statut: '0', lines: [] } },
      { statut: 200, corps: 1 },
    ]);
    await creerBonIntervention(config, 2, 42, c, 'INT-2026-0043', date);
    expect(JSON.parse(String(appels[0].init.body)).dateo).toBe(date.getTime() / 1000);
    expect(appels[3].url).toContain('/interventions/16/lines');
    expect(JSON.parse(String(appels[3].init.body))).toMatchObject({ date: date.getTime() / 1000, duree: 0 });
  });

  it('ne date pas deux fois, et ne touche pas une autre date', async () => {
    const date = new Date('2026-10-24T06:00:00Z');
    simuler([{ statut: 200, corps: { statut: '0', lines: [{ date: String(date.getTime() / 1000 + 3600) }] } }]);
    expect(await daterBon(config, 2, 16, date, 'x')).toBe('deja');
    simuler([{ statut: 200, corps: { statut: '0', lines: [{ date: '1793264400' }] } }]);
    expect(await daterBon(config, 2, 16, date, 'x')).toBe('autre');
    simuler([{ statut: 200, corps: { statut: '1', lines: [] } }]);
    expect(await daterBon(config, 2, 16, date, 'x')).toBe('impossible');
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

import { raisonRainbow } from './rainbow';
describe('erreurs Rainbow', () => {
  it('traduit « Wrong env for application id »', () => {
    expect(raisonRainbow({ code: 401, error: { errorDetailsCode: 401700, errorDetails: 'Wrong env' } })).toMatch(/pas en production/);
    expect(raisonRainbow({ code: 401, error: { errorDetailsCode: 401500, errorDetails: 'Invalid credentials' } })).toMatch(/refusés \(Invalid credentials\)/);
  });
});

import { sujetSansPrefixe } from './stockage';
describe('sujet d’une conversation', () => {
  it('retire les préfixes de réponse et de transfert', () => {
    expect(sujetSansPrefixe('Re: URGENT MAX IMMOBILIER')).toBe('urgent max immobilier');
    expect(sujetSansPrefixe('RE: TR: Re:  URGENT  MAX IMMOBILIER')).toBe('urgent max immobilier');
    expect(sujetSansPrefixe('Fwd: R: Bon de travaux 12')).toBe('bon de travaux 12');
    expect(sujetSansPrefixe('Réparation fosse')).toBe('réparation fosse');
  });
});

import { modifiesDepuis } from './dolibarr';
describe('relevés incrémentaux', () => {
  it('filtre « modifié depuis » avec trois heures de marge (fuseau de la base inconnu)', () => {
    expect(modifiesDepuis(new Date('2026-10-24T10:00:00Z'))).toBe("(t.tms:>=:'2026-10-24 07:00:00')");
  });
});
