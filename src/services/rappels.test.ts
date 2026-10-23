import { describe, expect, it } from 'vitest';
import exemple from '../../config.exemple.json';
import { validerConfig } from '../logique/config';
import { rappelRdv } from '../logique/modeles';
import type { Rdv } from '../lib/agenda';
import { emailsDuRdv } from './rappels';

const config = validerConfig(exemple);
const rdv = (p: Partial<Rdv>): Rdv => ({ titre: '', debut: null, fin: null, journeeEntiere: false, lieu: null, passe: false, description: '', uid: 'x', ...p });

describe('rappels de rendez-vous', () => {
  it("trouve l'adresse du client dans le rendez-vous, jamais celle du groupe", () => {
    expect(emailsDuRdv(rdv({ titre: 'Débouchage regard ERRARD Porticcio errard.ch@gmail.com', description: 'copie pb@groupecyrneo.com' }), config.domainesInternes)).toEqual(['errard.ch@gmail.com']);
    expect(emailsDuRdv(rdv({ titre: 'Vidange fosse Mme Santoni 06 11 22 33 44' }), config.domainesInternes)).toEqual([]);
  });

  it('rédige un rappel clair avec le jour, l’heure, le lieu et le numéro de la société', () => {
    const sa = config.societes.find((s) => s.id === 'sud-assainissement')!;
    const demain = new Date('2026-10-24T10:00:00Z');
    const m = rappelRdv({ nom: 'Madame Lux', objet: 'la vidange de votre fosse septique', debut: new Date('2026-10-24T07:30:00Z'), lieu: 'Lotissement Spunta di Sole, Cauro' }, demain, sa);
    expect(m.sujet).toBe('Rappel : notre passage demain samedi 24 octobre — Sud Assainissement');
    expect(m.texte).toContain('Bonjour Madame Lux,');
    expect(m.texte).toContain('demain, samedi 24 octobre à 09h30, pour la vidange de votre fosse septique');
    expect(m.texte).toContain('Adresse : Lotissement Spunta di Sole, Cauro');
    expect(m.texte).toContain('04 95 23 02 84');
    expect(m.html).toContain('cid:logo-societe@cyrneo');
  });

  it('rendez-vous sur la journée : pas d’heure inventée', () => {
    const sa = config.societes.find((s) => s.id === 'sud-assainissement')!;
    const m = rappelRdv({ nom: '', objet: 'le curage de votre réseau', debut: null, lieu: '' }, new Date('2026-10-24T10:00:00Z'), sa);
    expect(m.texte).toContain('samedi 24 octobre, dans la journée');
    expect(m.texte).not.toContain('Adresse :');
  });
});
