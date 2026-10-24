import { describe, expect, it } from 'vitest';
import { ligneContrat, ligneVidangeFosse, prixContrat, secteurDe, volumeDe, type Grille } from './contrat';

// Extrait de js/grille.js du site (la vraie grille est relue sur le site à chaque passage).
const g: Grille = {
  GRILLE: { 'Grand Ajaccio': [400, 450, 500, 550], Porticcio: [400, 450, 500, 550], 'Vero / Tavaco / Ucciani': [450, 500, 550, 600], 'Cuttoli / plaine de Cuttoli': [400, 450, 500, 550], Sagone: [500, 550, 600, 650] },
  ACCES_LOIN: 50,
};

describe('contrat 2 ans après une vidange', () => {
  it('reconnaît une vidange de fosse, pas un bac à graisse ni un contrat', () => {
    expect(ligneVidangeFosse('Vidange fosse septique 3m3')).toBe(true);
    expect(ligneVidangeFosse('Vidange bac à graisse')).toBe(false);
    expect(ligneContrat('Mensualité contrat entretien')).toBe(true);
  });
  it('trouve le secteur', () => {
    expect(secteurDe('Grosseto-Prugna', '', g)).toBe('Porticcio');
    expect(secteurDe('AJACCIO', 'route des Sanguinaires', g)).toBe('Grand Ajaccio');
    expect(secteurDe('Ucciani', '', g)).toBe('Vero / Tavaco / Ucciani');
    expect(secteurDe('Eccica-Suarella', '', g)).toBe('Cuttoli / plaine de Cuttoli');
    expect(secteurDe('Bonifacio', '', g)).toBeNull();
  });
  it('lit le volume sur la facture, sinon le retrouve par le prix', () => {
    expect(volumeDe([{ texte: 'Vidange fosse 4 m³', ttc: 450 }], 'Porticcio', g)).toEqual({ volume: 4, accesLoin: false });
    expect(volumeDe([{ texte: 'Vidange fosse toutes eaux', ttc: 600 }], 'Porticcio', g)).toEqual({ volume: 6, accesLoin: true });
    expect(volumeDe([{ texte: 'Vidange fosse', ttc: 123 }], 'Porticcio', g).volume).toBeNull();
  });
  it('mensualité sur 24 mois, arrondie au centime supérieur', () => {
    expect(prixContrat(g, 'Grand Ajaccio', 4, false)).toEqual({ vidange: 450, mensualite: 18.75 });
    expect(prixContrat(g, 'Sagone', 3, true)).toEqual({ vidange: 550, mensualite: 22.92 });
  });
});
