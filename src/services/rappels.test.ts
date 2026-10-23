import { describe, expect, it } from 'vitest';
import exemple from '../../config.exemple.json';
import { validerConfig } from '../logique/config';
import { rappelRdv } from '../logique/modeles';
import type { Rdv } from '../lib/agenda';
import { emailsDuRdv, suiteDeChantier } from './rappels';
import { rdvDuJour } from '../lib/agenda';

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
    expect(m.html).toContain('cid:groupe-cyrneo@cyrneo');
  });

  it('rendez-vous sur la journée : pas d’heure inventée', () => {
    const sa = config.societes.find((s) => s.id === 'sud-assainissement')!;
    const m = rappelRdv({ nom: '', objet: 'le curage de votre réseau', debut: null, lieu: '' }, new Date('2026-10-24T10:00:00Z'), sa);
    expect(m.texte).toContain('samedi 24 octobre, dans la journée');
    expect(m.texte).not.toContain('Adresse :');
  });

  it('pas de rappel pour la suite d’un chantier de plusieurs jours', () => {
    const ics = [
      'BEGIN:VCALENDAR', 'VERSION:2.0',
      'BEGIN:VEVENT', 'UID:chantier-1', 'DTSTART;VALUE=DATE:20261026', 'DTEND;VALUE=DATE:20261031', 'SUMMARY:Ravalement façade - Copro Les Oliviers', 'END:VEVENT',
      'BEGIN:VEVENT', 'UID:j1', 'DTSTART;TZID=Europe/Paris:20261026T080000', 'DTEND;TZID=Europe/Paris:20261026T170000', 'SUMMARY:Peinture cage escalier - Mme Leca', 'END:VEVENT',
      'BEGIN:VEVENT', 'UID:j2', 'DTSTART;TZID=Europe/Paris:20261027T080000', 'DTEND;TZID=Europe/Paris:20261027T170000', 'SUMMARY:Peinture cage d’escalier – Mme LECA', 'END:VEVENT',
      'BEGIN:VEVENT', 'UID:j3', 'DTSTART;TZID=Europe/Paris:20261027T140000', 'DTEND;TZID=Europe/Paris:20261027T150000', 'SUMMARY:Vidange fosse - M. Errard', 'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const lundi = rdvDuJour(ics, new Date('2026-10-26T10:00:00Z'));
    const mardi = rdvDuJour(ics, new Date('2026-10-27T10:00:00Z'));
    const suite = (titre: RegExp) => suiteDeChantier(mardi.find((r) => titre.test(r.titre))!, lundi);
    expect(suite(/Ravalement/)).toBe(true); // même événement sur toute la semaine
    expect(suite(/Leca/i)).toBe(true); // même chantier repris d'un jour à l'autre
    expect(suite(/Errard/)).toBe(false); // nouveau client : rappel
  });

  it('journée entière : la date de fin (exclusive) n’est pas un jour de chantier', () => {
    const ics = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:c', 'DTSTART;VALUE=DATE:20261026', 'DTEND;VALUE=DATE:20261029', 'SUMMARY:Ravalement', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
    expect(rdvDuJour(ics, new Date('2026-10-28T10:00:00Z'))).toHaveLength(1);
    expect(rdvDuJour(ics, new Date('2026-10-29T10:00:00Z'))).toHaveLength(0);
    expect(rdvDuJour(ics, new Date('2026-10-25T22:30:00Z'))).toHaveLength(0); // dimanche 23 h 30 à Paris
  });
});
