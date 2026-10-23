import { describe, expect, it } from 'vitest';
import exemple from '../../config.exemple.json';
import { validerConfig } from './config';
import { controlerFacture, resumeFacture, trouverFournisseur, type FactureLue } from './facture';
import { indexer, type Tiers } from './tiers';

const { societes } = validerConfig(exemple);
const facture = (plus: Partial<FactureLue> = {}): FactureLue => ({
  estFactureFournisseur: true, avoir: false,
  fournisseur: { nom: 'Corse Carburants SARL', siret: '123 456 789 00012', tvaIntra: '', adresse: '', cp: '', ville: 'Ajaccio', email: '', telephone: '' },
  societe: 'sud-assainissement', numero: 'F-2026-118', date: '2026-10-20', echeance: '2026-11-20', libelle: 'Gasoil octobre',
  ventilation: [{ taux: 20, ht: 1000 }, { taux: 10, ht: 100 }], totalHt: 1100, totalTva: 210, totalTtc: 1310, ...plus,
});
const t = (id: number, nom: string, plus: Partial<Tiers> = {}): Tiers => ({
  id, nom, alias: '', code_client: '', code_fournisseur: `FO${id}`, siret: '', tva_intra: '', adresse: '', cp: '', ville: '', telephone: '', email: '',
  parent_id: null, client: 0, fournisseur: 1, actif: true, note_publique: '', note_privee: '', ...plus,
});

describe('factures fournisseurs', () => {
  it('accepte une facture cohérente, ventilée sur deux taux', () => {
    expect(controlerFacture(facture(), societes)).toBeNull();
  });

  it('refuse les totaux incohérents, la société inconnue, le numéro manquant', () => {
    expect(controlerFacture(facture({ totalTtc: 1400 }), societes)).toMatch(/totaux incohérents/);
    expect(controlerFacture(facture({ societe: 'inconnue' }), societes)).toMatch(/société facturée/);
    expect(controlerFacture(facture({ numero: ' ' }), societes)).toMatch(/numéro/);
    expect(controlerFacture(facture({ ventilation: [{ taux: 20, ht: 1100 }] }), societes)).toMatch(/TVA recalculée/);
  });

  it('retrouve le fournisseur par SIREN, puis par domaine, puis par nom exact', () => {
    const index = indexer([t(1, 'CORSE CARBURANTS', { siret: '12345678900099' }), t(2, 'Garage Leca', { email: 'compta@garage-leca.fr' }), t(3, 'Pneus 2A')], []);
    expect(trouverFournisseur(index, facture().fournisseur, 'x@y.fr')?.id).toBe(1);
    expect(trouverFournisseur(index, { ...facture().fournisseur, nom: 'Garage LECA SARL', siret: '' }, 'factures@garage-leca.fr')?.id).toBe(2);
    expect(trouverFournisseur(index, { ...facture().fournisseur, nom: 'PNEUS 2A', siret: '' }, 'pneus2a@gmail.com')?.id).toBe(3);
    expect(trouverFournisseur(index, { ...facture().fournisseur, nom: 'Inconnu & Fils', siret: '' }, 'a@gmail.com')).toBeNull();
  });

  it('résume la facture pour la bulle admin', () => {
    expect(resumeFacture(facture(), societes).replace(/\s/g, ' ')).toBe('Facture F-2026-118 · Corse Carburants SARL → Sud Assainissement · 1 310,00 € TTC · Gasoil octobre');
  });
});
