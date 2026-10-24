import { describe, expect, it } from 'vitest';
import type { Rdv } from '../lib/agenda';
import { rdvDuClient, rdvPlanifie } from './planning';

const rdv = (titre: string, description = ''): Rdv => ({ titre, debut: null, fin: null, journeeEntiere: true, lieu: null, passe: false, description, uid: titre });
const fiche = { client_nom: 'M. et Mme Cardineau (locataires)', client_telephone: '07 85 21 88 72', cree_le: '2026-10-23T08:00:00Z' };

describe('rapprochement avec les plannings', () => {
  it('reconnaît le client par son nom ou son téléphone dans le rendez-vous', () => {
    expect(rdvDuClient(fiche, rdv('Débouchage machine à laver CARDINEAU Aspretto'))).toBe(true);
    expect(rdvDuClient(fiche, rdv('Débouchage Aspretto', 'contact 0785218872'))).toBe(true);
    expect(rdvDuClient(fiche, rdv('Vidange fosse Mme Leca'))).toBe(false);
  });

  it('ne retient que les rendez-vous à partir de la veille de la demande', () => {
    const ancien = { date: new Date('2026-09-01T08:00:00Z'), rdv: rdv('Débouchage Cardineau') };
    const lundi = { date: new Date('2026-10-26T12:00:00Z'), rdv: rdv('Débouchage Cardineau Aspretto') };
    expect(rdvPlanifie(fiche, [ancien])).toBeNull();
    expect(rdvPlanifie(fiche, [ancien, lundi])?.date).toEqual(lundi.date);
  });
});
