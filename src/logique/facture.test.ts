import { describe, expect, it } from 'vitest';
import exemple from '../../config.exemple.json';
import { validerConfig } from './config';
import { controlerFacture, prixUnitaireSaisi, resumeFacture, trouverFournisseur, type FactureLue } from './facture';
import { indexer, type Tiers } from './tiers';

const { societes } = validerConfig(exemple);
const facture = (plus: Partial<FactureLue> = {}): FactureLue => ({
  estFactureFournisseur: true, avoir: false,
  fournisseur: { nom: 'Corse Carburants SARL', siret: '123 456 789 00012', tvaIntra: '', adresse: '', cp: '', ville: 'Ajaccio', email: '', telephone: '' },
  societe: 'sud-assainissement', numero: 'F-2026-118', date: '2026-10-20', echeance: '2026-11-20', libelle: 'Gasoil octobre',
  lignes: [
    { description: 'Gasoil 800 L', quantite: 800, prixUnitaireHt: 1.25, remisePct: 0, tauxTva: 20, totalHt: 1000 },
    { description: 'Lavage', quantite: 2, prixUnitaireHt: 55.56, remisePct: 10, tauxTva: 10, totalHt: 100 },
  ], totalHt: 1100, totalTva: 210, totalTtc: 1310, ...plus,
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
    const [a, b] = facture().lignes;
    expect(controlerFacture(facture({ lignes: [a] }), societes)).toMatch(/ligne manquante/);
    expect(controlerFacture(facture({ lignes: [a, { ...b, tauxTva: 20 }] }), societes)).toMatch(/TVA recalculée/);
    expect(controlerFacture(facture({ lignes: [a, { ...b, quantite: 3 }] }), societes)).toMatch(/ligne 2 incohérente/);
  });

  it('corrige un prix unitaire arrondi à l’impression pour retomber sur le total de la ligne', () => {
    const l = { description: 'Gasoil', quantite: 800, prixUnitaireHt: 1.253, remisePct: 0, tauxTva: 20, totalHt: 1002.72 };
    expect(controlerFacture(facture({ lignes: [l, facture().lignes[1]], totalHt: 1102.72, totalTva: 210.54, totalTtc: 1313.26 }), societes)).toBeNull();
    expect(prixUnitaireSaisi(l)).toBe(1.2534);
    expect(prixUnitaireSaisi(facture().lignes[0])).toBe(1.25);
  });

  it('retrouve le fournisseur par SIREN, puis par domaine, puis par nom exact', () => {
    const index = indexer([t(1, 'CORSE CARBURANTS', { siret: '12345678900099' }), t(2, 'Garage Leca', { email: 'compta@garage-leca.fr' }), t(3, 'Pneus 2A')], []);
    expect(trouverFournisseur(index, facture().fournisseur, 'x@y.fr')?.id).toBe(1);
    expect(trouverFournisseur(index, { ...facture().fournisseur, nom: 'Garage LECA SARL', siret: '' }, 'factures@garage-leca.fr')?.id).toBe(2);
    expect(trouverFournisseur(index, { ...facture().fournisseur, nom: 'PNEUS 2A', siret: '' }, 'pneus2a@gmail.com')?.id).toBe(3);
    expect(trouverFournisseur(index, { ...facture().fournisseur, nom: 'Inconnu & Fils', siret: '' }, 'a@gmail.com')).toBeNull();
  });

  it('résume la facture pour la bulle admin', () => {
    expect(resumeFacture(facture(), societes).replace(/\s/g, ' ')).toBe('Facture F-2026-118 · Corse Carburants SARL → Sud Assainissement · 1 310,00 € TTC · Gasoil octobre · 2 lignes');
  });
});
