import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import zlib from 'node:zlib';
import { contratDocx, mandatDocx, rum, valeursContrat } from './contrat-docs';
import { synthese } from '../services/contrats';

const d = { client_nom: 'Mme Santoni', adresse: '12 route de la Parata', cp: '20000', ville: 'Ajaccio', telephone: '06', email: 'a@b.fr', secteur: 'Grand Ajaccio', volume: 4, acces_loin: false, vidange_ttc: 450, mensualite: 18.75, reference: 'CT2610-0012', rum: 'SUDASSAI-SANTONI-2026' };

/** Texte de word/document.xml d'un docx (première entrée « document.xml » trouvée). */
function documentXml(buf: Buffer): string {
  const i = buf.indexOf('word/document.xml');
  const local = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]), i);
  const taille = buf.readUInt32LE(local + 18);
  const debut = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
  return zlib.inflateRawSync(buf.subarray(debut, debut + taille)).toString('utf8');
}

describe('contrat type et mandat', () => {
  it('remplit tous les champs du contrat type', () => {
    const x = documentXml(contratDocx(readFileSync('assets/contrats/contrat-fosse.docx'), d));
    expect(x).not.toMatch(/\{\{/);
    expect(x).toContain('18,75 € TTC / mois');
    expect(x).toContain('450,00 € TTC sur 24 mois');
    expect(x).toContain('Vidange tous les 2 ans');
    expect(valeursContrat(d).type_bac).toBe('4 m³');
  });
  it('mandat pré-rempli, IBAN laissé au client', () => {
    const x = documentXml(mandatDocx(d));
    expect(x).toContain('SUDASSAI-SANTONI-2026');
    expect(x).toContain('FR52ZZZ620650');
    expect(x).toContain('Mme Santoni');
  });
  it('RUM sans la civilité', () => expect(rum('Mme Marie Santoni', 2026)).toBe('SUDASSAI-MARIESANTO-2026'));
});

describe('relances contrats', () => {
  it('à faire, conversion, CA potentiel, CA signé, volume', () => {
    const c = (statut: string, mensualite: number | null, volume = 3) => ({ statut, mensualite, volume, total_ttc: null }) as never;
    const s = synthese([c('a_completer', null), c('pret', 20), c('emis', 18.75, 4), c('signe', 16.67), c('abandonne', 20), c('ecarte', 20)]);
    expect(s).toMatchObject({ aFaire: 2, emises: 3, signees: 1, volume: 5, volumeM3: 16 });
    expect(s.ratio).toBeCloseTo(1 / 3);
    expect(s.caPotentiel).toBeCloseTo(20 * 24 + 450);
    expect(s.caSigne).toBeCloseTo(16.67 * 24);
  });
});
