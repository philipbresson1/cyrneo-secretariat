import { describe, expect, it } from 'vitest';
import { blocRainbow } from '../services/tiers';
import { candidats, estSyndic, evident, indexer, syndicExpediteur, type Tiers } from './tiers';

const t = (id: number, nom: string, plus: Partial<Tiers> = {}): Tiers => ({
  id, nom, alias: '', code_client: `CU${id}`, adresse: '', cp: '', ville: '', telephone: '', email: '', parent_id: null,
  client: 1, fournisseur: 0, actif: true, note_publique: '', note_privee: '', ...plus,
});

const index = indexer(
  [
    t(1, 'MAX IMMOBILIER', { email: 'gestion@maximmo.fr' }),
    t(2, 'Villa Aspretto Panorama 2', { adresse: 'Aspretto', ville: 'Ajaccio', parent_id: 1, note_publique: 'Code portail 1234' }),
    t(3, 'Résidence Panorama', { ville: 'Porticcio' }),
    t(4, 'Jean Leca', { telephone: '06 12 34 56 78', ville: 'Cauro' }),
  ],
  [{ id: 10, tiers_id: 1, nom: 'Sandra', email: 'sandra@maximmo.fr', telephone: '', poste: 'gestionnaire' }]
);
const demande = { expediteur: 'sandra@maximmo.fr', nom: 'M. et Mme Cardineau', email: '', telephone: '07 85 21 88 72', adresse: 'Villa Aspretto Panorama 2', commune: 'Ajaccio', texte: 'Max Immobilier : évacuation bouchée' };

describe('reconnaissance du tiers', () => {
  it('reconnaît le syndic par le contact qui écrit', () => {
    const s = syndicExpediteur(index, 'Sandra@maximmo.fr');
    expect(s?.id).toBe(1);
    expect(estSyndic(index, s!)).toBe(true);
  });

  it('retient la résidence rattachée au syndic, jamais le syndic lui-même', () => {
    const syndic = syndicExpediteur(index, demande.expediteur);
    const liste = candidats(index, demande, syndic);
    expect(liste[0].tiers.id).toBe(2);
    expect(liste.map((c) => c.tiers.id)).not.toContain(1);
    expect(evident(liste)).toBe(true);
  });

  it('trouve un particulier par son téléphone', () => {
    const liste = candidats(index, { ...demande, expediteur: 'jean@orange.fr', nom: 'Jean', adresse: '', commune: '', texte: 'fosse pleine', telephone: '+33 6 12 34 56 78' }, null);
    expect(liste[0].tiers.id).toBe(4);
  });

  it('ne propose rien quand rien ne correspond', () => {
    expect(candidats(index, { ...demande, expediteur: 'x@gmail.com', nom: 'Inconnu', telephone: '', adresse: 'Lieu-dit Suarella', commune: 'Bastelica', texte: 'wc bouchés' }, null)).toEqual([]);
  });

  it('présente le tiers, son syndic et sa note dans Rainbow', () => {
    const texte = blocRainbow({ tiers: index.tiers.get(2)!, syndic: index.tiers.get(1)!, possibles: [], index });
    expect(texte).toContain('Villa Aspretto Panorama 2');
    expect(texte).toContain('syndic : MAX IMMOBILIER');
    expect(texte).toContain('Code portail 1234');
    expect(blocRainbow({ tiers: null, syndic: index.tiers.get(1)!, possibles: [], index })).toMatch(/non trouvé.*\n.*Syndic : MAX IMMOBILIER/);
  });
});
