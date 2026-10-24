import { describe, expect, it } from 'vitest';
import { dateDuBon, datesDuBon, depuisParis } from './date-bon';
import { joursAPreparer } from '../services/veille';
import { jourParis } from '../lib/agenda';

const recu = new Date('2026-10-23T19:40:00Z'); // vendredi soir, heure de Paris 21h40

describe("date d'intervention du bon", () => {
  it('débouchage : le jour de la demande', () => {
    expect(dateDuBon({ nature: 'débouchage évier', creneau: '', creneauType: '' }, recu)).toEqual(recu);
  });
  it('débouchage à rappeler demain 8h : le lendemain 8h', () => {
    const d = dateDuBon({ nature: 'Débouchage WC', creneau: '2026-10-24T08:00', creneauType: 'rappel' }, recu)!;
    expect(d.toISOString()).toBe('2026-10-24T06:00:00.000Z');
  });
  it('vidange au jour X : ce jour-là', () => {
    expect(dateDuBon({ nature: 'vidange fosse 3 m³', creneau: '2026-11-03T09:00', creneauType: 'intervention' }, recu)).toEqual(depuisParis('2026-11-03T09:00'));
  });
  it('vidange sans date, ou seulement un rappel : pas de date (posée la veille)', () => {
    expect(dateDuBon({ nature: 'vidange fosse', creneau: '', creneauType: '' }, recu)).toBeNull();
    expect(dateDuBon({ nature: 'vidange fosse', creneau: '2026-10-26T08:00', creneauType: 'rappel' }, recu)).toBeNull();
  });
  it('lit les dates des lignes, ou du champ complémentaire réglé', () => {
    const b = { dateo: 1, lines: [{ date: '1793264400' }], array_options: { options_date_inter: 1793350800 } };
    expect(datesDuBon(b).map(jourParis)).toEqual(['2026-10-29']);
    expect(datesDuBon(b, 'date_inter').map(jourParis)).toEqual(['2026-10-30']);
  });
});

describe('veille : jours à préparer', () => {
  it('mardi → mercredi', () => expect(joursAPreparer(new Date('2026-10-27T15:00:00Z'))).toEqual(['2026-10-28']));
  it('vendredi → samedi, dimanche, lundi', () => expect(joursAPreparer(new Date('2026-10-23T15:00:00Z'))).toEqual(['2026-10-24', '2026-10-25', '2026-10-26']));
});
